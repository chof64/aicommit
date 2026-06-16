import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResponse } from "../src/api.js";
import {
  buildMessages,
  callWithRetry,
  categorizeError,
  MAX_RETRIES,
  parseCommitMessage,
  RETRY_DELAY_MS,
  redact,
  SYSTEM_PROMPT,
} from "../src/api.js";
import { HttpApiError, ParseError, TimeoutError } from "../src/errors.js";

describe("buildMessages", () => {
  it("produces a system message and a user message", () => {
    const msgs = buildMessages("", "diff --git a");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[0]?.content).toBe(SYSTEM_PROMPT);
    expect(msgs[1]?.role).toBe("user");
    expect(msgs[1]?.content).toContain("diff --git a");
  });

  it("emits the standard instruction tail in the user prompt", () => {
    const msgs = buildMessages("", "the diff");
    expect(msgs[1]?.content).toMatch(/conventional commit format/);
    expect(msgs[1]?.content.endsWith("the diff")).toBe(true);
  });

  it("prepends the hint prefix when a hint is given", () => {
    const msgs = buildMessages("Context/hint: fix bug ", "the diff");
    expect(msgs[1]?.content.startsWith("Context/hint: fix bug ")).toBe(true);
  });

  it("does not prepend a hint prefix when none is given", () => {
    const msgs = buildMessages("", "the diff");
    expect(msgs[1]?.content.startsWith("Context/hint:")).toBe(false);
  });
});

describe("parseCommitMessage", () => {
  it("extracts the trimmed content from the first choice", () => {
    const out = parseCommitMessage({
      choices: [{ message: { content: "  feat: thing\n" } }],
    });
    expect(out).toBe("feat: thing");
  });

  it("throws ParseError on empty content", () => {
    expect(() => parseCommitMessage({ choices: [{ message: { content: "" } }] })).toThrow(
      ParseError,
    );
  });

  it("throws ParseError on the literal string 'null'", () => {
    expect(() => parseCommitMessage({ choices: [{ message: { content: "null" } }] })).toThrow(
      ParseError,
    );
  });

  it("throws ParseError on missing choices", () => {
    expect(() => parseCommitMessage({} as unknown as ApiResponse)).toThrow(ParseError);
  });
});

describe("callWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns the response on first success without sleeping", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "feat: x" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callWithRetry([{ role: "user", content: "hi" }], "k");
    expect(result.choices[0]?.message.content).toBe("feat: x");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries once after a 500 and succeeds on the second attempt (5xx is transient)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 500, statusText: "Server Error" }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "feat: retry" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const promise = callWithRetry([{ role: "user", content: "hi" }], "k").catch((e) => e);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      choices: [{ message: { content: "feat: retry" } }],
    });
  });

  it("rethrows the last HttpApiError after exhausting retries on persistent 503", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("down", { status: 503, statusText: "Service Unavailable" }));
    vi.stubGlobal("fetch", fetchMock);

    const settled = callWithRetry([{ role: "user", content: "hi" }], "k").then(
      () => "resolved",
      (e) => e,
    );
    for (let i = 0; i <= MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    }
    const result = (await settled) as unknown;

    expect(fetchMock).toHaveBeenCalledTimes(MAX_RETRIES + 1);
    expect(result).toBeInstanceOf(HttpApiError);
    expect((result as HttpApiError).status).toBe(503);
  });

  it.each([
    401, 403, 400, 429,
  ])("does not retry on %i (auth/bad-request/rate-limit)", async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status, statusText: "Nope" }));
    vi.stubGlobal("fetch", fetchMock);

    const settled = callWithRetry([{ role: "user", content: "hi" }], "k").then(
      () => "resolved",
      (e) => e,
    );
    // Advance past any timer that might fire even though we expect no retry.
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * (MAX_RETRIES + 1));
    const result = (await settled) as unknown;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toBeInstanceOf(HttpApiError);
    expect((result as HttpApiError).status).toBe(status);
  });

  it("does not retry on TimeoutError", async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_input: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const settled = callWithRetry([{ role: "user", content: "hi" }], "k").then(
      () => "resolved",
      (e) => e,
    );
    // Advance past TIMEOUT_MS (60s) to trigger the abort, then drain microtasks.
    await vi.advanceTimersByTimeAsync(61_000);
    const result = (await settled) as unknown;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toBeInstanceOf(TimeoutError);
  });

  it("wraps response.json() parse failure in ParseError", async () => {
    // This test exercises a real microtask (response.json()) — fake timers
    // would starve it. Disable them locally.
    vi.useRealTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("not-json{{", { status: 200, statusText: "OK" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = (await callWithRetry([{ role: "user", content: "hi" }], "k").catch(
      (e) => e,
    )) as unknown;

    expect(result).toBeInstanceOf(ParseError);
    expect((result as ParseError).cause).toBeDefined();
  });
});

describe("categorizeError", () => {
  it("returns auth for 401 and 403", () => {
    expect(categorizeError(new HttpApiError("x", { status: 401 })).category).toBe("auth");
    expect(categorizeError(new HttpApiError("x", { status: 403 })).category).toBe("auth");
  });

  it("returns rate-limit for 429", () => {
    expect(categorizeError(new HttpApiError("x", { status: 429 })).category).toBe("rate-limit");
  });

  it("returns bad-request for 400", () => {
    expect(categorizeError(new HttpApiError("x", { status: 400 })).category).toBe("bad-request");
  });

  it("returns server for 5xx", () => {
    expect(categorizeError(new HttpApiError("x", { status: 500 })).category).toBe("server");
    expect(categorizeError(new HttpApiError("x", { status: 502 })).category).toBe("server");
  });

  it("returns timeout for TimeoutError, AbortError, and 408", () => {
    expect(categorizeError(new TimeoutError("t")).category).toBe("timeout");
    const abort = new Error("a");
    abort.name = "AbortError";
    expect(categorizeError(abort).category).toBe("timeout");
    expect(categorizeError(new HttpApiError("x", { status: 408 })).category).toBe("timeout");
  });

  it("returns network for TypeError", () => {
    expect(categorizeError(new TypeError("ECONNREFUSED")).category).toBe("network");
  });

  it("returns unknown for unrecognized errors", () => {
    expect(categorizeError(new Error("weird")).category).toBe("unknown");
    expect(categorizeError("string error").category).toBe("unknown");
  });
});

describe("redact", () => {
  it("returns short strings unchanged", () => {
    expect(redact("feat: x", 80)).toBe("feat: x");
  });

  it("truncates long strings and reports the original length", () => {
    const long = "a".repeat(100);
    const out = redact(long, 10);
    expect(out.startsWith("a".repeat(10))).toBe(true);
    expect(out).toContain("…");
    expect(out).toContain("100 chars");
  });
});
