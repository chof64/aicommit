import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResponse } from "../src/api.js";
import {
  backoffMs,
  buildMessages,
  callWithRetry,
  MAX_RETRIES,
  parseCommitMessage,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
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

describe("backoffMs", () => {
  it("doubles the base on each attempt (2s, 4s, 8s, …)", () => {
    expect(backoffMs(0)).toBe(RETRY_BASE_MS);
    expect(backoffMs(1)).toBe(RETRY_BASE_MS * 2);
    expect(backoffMs(2)).toBe(RETRY_BASE_MS * 4);
    expect(backoffMs(3)).toBe(RETRY_BASE_MS * 8);
  });

  it("caps the per-retry delay at RETRY_MAX_MS", () => {
    expect(backoffMs(10)).toBe(RETRY_MAX_MS);
    expect(backoffMs(20)).toBe(RETRY_MAX_MS);
  });

  it("uses retryAfterMs when provided, even at attempt 0", () => {
    expect(backoffMs(0, 5_000)).toBe(5_000);
    expect(backoffMs(2, 12_345)).toBe(12_345);
  });

  it("ignores negative or NaN retryAfterMs", () => {
    expect(backoffMs(0, -1)).toBe(RETRY_BASE_MS);
    expect(backoffMs(0, Number.NaN)).toBe(RETRY_BASE_MS);
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

  it("retries after a 500 and succeeds on the second attempt (5xx is transient)", async () => {
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
    // First retry waits RETRY_BASE_MS (2s).
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      choices: [{ message: { content: "feat: retry" } }],
    });
  });

  it("retries 429 with exponential backoff", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow", { status: 429, statusText: "Too Many Requests" }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "feat: ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const promise = callWithRetry([{ role: "user", content: "hi" }], "k").catch((e) => e);
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ choices: [{ message: { content: "feat: ok" } }] });
  });

  it("retries 408 with exponential backoff", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow", { status: 408, statusText: "Request Timeout" }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "feat: ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const promise = callWithRetry([{ role: "user", content: "hi" }], "k").catch((e) => e);
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ choices: [{ message: { content: "feat: ok" } }] });
  });

  it("honors Retry-After header on a 429", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("slow", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "Retry-After": "10" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "feat: ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const promise = callWithRetry([{ role: "user", content: "hi" }], "k").catch((e) => e);
    // Retry-After overrides the 2s exponential delay with 10s.
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ choices: [{ message: { content: "feat: ok" } }] });
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
    // Walk the exponential schedule: 2s, 4s, 8s = 14s total across 3 retries.
    for (let i = 0; i < MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(backoffMs(i));
    }
    const result = (await settled) as unknown;

    expect(fetchMock).toHaveBeenCalledTimes(MAX_RETRIES + 1);
    expect(result).toBeInstanceOf(HttpApiError);
    expect((result as HttpApiError).status).toBe(503);
  });

  it.each([401, 403, 400])("does not retry on %i (auth/bad-request)", async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status, statusText: "Nope" }));
    vi.stubGlobal("fetch", fetchMock);

    const settled = callWithRetry([{ role: "user", content: "hi" }], "k").then(
      () => "resolved",
      (e) => e,
    );
    // Advance past the entire possible backoff window to ensure no retry fires.
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * (MAX_RETRIES + 1));
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

describe("HttpApiError.fromResponse", () => {
  it("maps 401 and 403 to auth with a verification hint", () => {
    const e401 = HttpApiError.fromResponse(401, "Unauthorized", "");
    expect(e401.category).toBe("auth");
    expect(e401.shouldRetry).toBe(false);
    expect(e401.suggestions.some((s) => /OPENCODE_API_KEY/.test(s))).toBe(true);

    const e403 = HttpApiError.fromResponse(403, "Forbidden", "");
    expect(e403.category).toBe("auth");
  });

  it("maps 429 to rate-limit and is retriable", () => {
    const e = HttpApiError.fromResponse(429, "Too Many Requests", "");
    expect(e.category).toBe("rate-limit");
    expect(e.shouldRetry).toBe(true);
  });

  it("propagates retryAfterMs onto 429 errors", () => {
    const e = HttpApiError.fromResponse(429, "Too Many Requests", "", 7_000);
    expect(e.retryAfterMs).toBe(7_000);
    expect(e.shouldRetry).toBe(true);
  });

  it("propagates retryAfterMs onto 5xx errors", () => {
    const e = HttpApiError.fromResponse(503, "Service Unavailable", "", 15_000);
    expect(e.retryAfterMs).toBe(15_000);
  });

  it("maps 400 to bad-request and is not retriable", () => {
    const e = HttpApiError.fromResponse(400, "Bad Request", "");
    expect(e.category).toBe("bad-request");
    expect(e.shouldRetry).toBe(false);
  });

  it("maps 5xx to server and marks it retriable", () => {
    for (const s of [500, 502, 503]) {
      const e = HttpApiError.fromResponse(s, "x", "");
      expect(e.category).toBe("server");
      expect(e.shouldRetry).toBe(true);
    }
  });

  it("maps 408 to timeout and is retriable", () => {
    const e = HttpApiError.fromResponse(408, "Request Timeout", "");
    expect(e.category).toBe("timeout");
    expect(e.shouldRetry).toBe(true);
  });

  it("falls through to unknown for unrecognized statuses", () => {
    const e = HttpApiError.fromResponse(418, "I'm a teapot", "");
    expect(e.category).toBe("unknown");
    expect(e.shouldRetry).toBe(false);
  });

  it("includes the status text and body snippet in the message", () => {
    const e = HttpApiError.fromResponse(500, "Internal Server Error", "boom");
    expect(e.message).toContain("500");
    expect(e.message).toContain("Internal Server Error");
    expect(e.message).toContain("boom");
  });
});

describe("redact", () => {
  it("returns short strings unchanged", () => {
    expect(redact("feat: x", 80)).toBe("feat: x");
  });

  it("truncates long strings and reports original length", () => {
    const long = "a".repeat(100);
    const out = redact(long, 10);
    expect(out.startsWith("a".repeat(10))).toBe(true);
    expect(out).toContain("…");
    expect(out).toContain("100 chars");
  });
});
