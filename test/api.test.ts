import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResponse } from "../src/api.js";
import {
  buildMessages,
  callWithRetry,
  MAX_RETRIES,
  parseCommitMessage,
  RETRY_DELAY_MS,
  SYSTEM_PROMPT,
} from "../src/api.js";

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

  it("exits when the content is empty", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(() => parseCommitMessage({ choices: [{ message: { content: "" } }] })).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr).toHaveBeenCalled();

    exit.mockRestore();
    stderr.mockRestore();
  });

  it("exits when the content is the literal string 'null'", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(() => parseCommitMessage({ choices: [{ message: { content: "null" } }] })).toThrow(
      "exit",
    );
    expect(exit).toHaveBeenCalledWith(1);

    exit.mockRestore();
    stderr.mockRestore();
  });

  it("exits when the response shape is missing choices", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(() => parseCommitMessage({} as unknown as ApiResponse)).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);

    exit.mockRestore();
    stderr.mockRestore();
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

  it("retries once after a 500 and succeeds on the second attempt", async () => {
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

    // Attach a no-op catch to keep the in-flight rejection quiet while timers run.
    const promise = callWithRetry([{ role: "user", content: "hi" }], "k").catch((e) => e);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      choices: [{ message: { content: "feat: retry" } }],
    });
  });

  it("exits after exhausting retries on persistent failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("down", { status: 503, statusText: "Service Unavailable" }));
    vi.stubGlobal("fetch", fetchMock);

    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // Attach a handler up front so the in-flight rejection never goes unhandled.
    const settled = callWithRetry([{ role: "user", content: "hi" }], "k").then(
      () => "resolved",
      (e) => e,
    );
    for (let i = 0; i <= MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    }
    const result = await settled;

    expect(fetchMock).toHaveBeenCalledTimes(MAX_RETRIES + 1);
    expect((result as Error).message).toBe("exit");
    expect(exit).toHaveBeenCalledWith(1);

    exit.mockRestore();
    stderr.mockRestore();
  });
});
