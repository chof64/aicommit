import { describe, expect, it } from "vitest";
import { redact } from "../src/api.js";
import {
  AbortError,
  AicommitError,
  ConfigError,
  ExitCode,
  formatError,
  GitError,
  HttpApiError,
  NetworkError,
  ParseError,
  TimeoutError,
  ValidationError,
} from "../src/errors.js";

describe("error hierarchy", () => {
  it("AicommitError subclasses set the right code and category", () => {
    expect(new ConfigError("c").code).toBe("config");
    expect(new GitError("g").code).toBe("git");
    expect(new ValidationError("v").code).toBe("validation");
    expect(new HttpApiError("h", { status: 500 }).code).toBe("api");
    expect(new TimeoutError("t").code).toBe("timeout");
    expect(new NetworkError("n").code).toBe("network");
    expect(new ParseError("p").code).toBe("parse");
    expect(new AbortError().code).toBe("abort");
  });

  it("every subclass is an AicommitError", () => {
    for (const e of [
      new ConfigError("c"),
      new GitError("g"),
      new ValidationError("v"),
      new HttpApiError("h", { status: 500 }),
      new TimeoutError("t"),
      new NetworkError("n"),
      new ParseError("p"),
      new AbortError(),
    ]) {
      expect(e).toBeInstanceOf(AicommitError);
    }
  });

  it("TimeoutError has status 408 and is not retriable", () => {
    const e = new TimeoutError("t");
    expect(e.status).toBe(408);
    expect(e.shouldRetry).toBe(false);
    expect(e.category).toBe("timeout");
  });

  it("NetworkError is retriable and exits EX_UNAVAILABLE", () => {
    const e = new NetworkError("n");
    expect(e.shouldRetry).toBe(true);
    expect(e.exitCode).toBe(ExitCode.EX_UNAVAILABLE);
  });

  it("ConfigError exits EX_USAGE", () => {
    expect(new ConfigError("c").exitCode).toBe(ExitCode.EX_USAGE);
  });

  it("ValidationError exits EX_DATAERR", () => {
    expect(new ValidationError("v").exitCode).toBe(ExitCode.EX_DATAERR);
  });

  it("ParseError exits EX_DATAERR", () => {
    expect(new ParseError("p").exitCode).toBe(ExitCode.EX_DATAERR);
  });

  it("AbortError exits EX_ABORT and defaults its message", () => {
    const e = new AbortError();
    expect(e.exitCode).toBe(ExitCode.EX_ABORT);
    expect(e.message).toBe("Aborted.");
    expect(e.shouldRetry).toBe(false);
  });

  it("HttpApiError preserves the status", () => {
    expect(new HttpApiError("h", { status: 502 }).status).toBe(502);
  });

  it("HttpApiError defaults to category 'unknown' and no retry", () => {
    const e = new HttpApiError("h", { status: 500 });
    expect(e.category).toBe("unknown");
    expect(e.shouldRetry).toBe(false);
  });

  it("cause and suggestions round-trip", () => {
    const cause = new Error("root");
    const e = new GitError("g", { cause, suggestions: ["hint"] });
    expect(e.cause).toBe(cause);
    expect(e.suggestions).toEqual(["hint"]);
  });

  it("suggestions array is frozen", () => {
    const e = new GitError("g", { suggestions: ["a"] });
    expect(() => {
      (e.suggestions as string[]).push("b");
    }).toThrow();
  });
});

describe("formatError", () => {
  it("renders title, body, and suggestions for AicommitError", () => {
    const out = formatError(
      new ConfigError("OPENCODE_API_KEY is not set", {
        suggestions: ["Set it with: export OPENCODE_API_KEY=<value>"],
      }),
      { verbose: false },
    );
    expect(out).toMatch(/Error:/);
    expect(out).toMatch(/OPENCODE_API_KEY is not set/);
    expect(out).toMatch(/Set it with: export OPENCODE_API_KEY/);
  });

  it("includes cause details in verbose mode", () => {
    const cause = new Error("root cause detail");
    const out = formatError(new GitError("git failed", { cause }), { verbose: true });
    expect(out).toMatch(/root cause detail/);
  });

  it("omits cause details when not verbose", () => {
    const cause = new Error("root cause detail");
    const out = formatError(new GitError("git failed", { cause }), { verbose: false });
    expect(out).not.toMatch(/root cause detail/);
  });

  it("wraps unknown errors with 'unexpected error' title", () => {
    const out = formatError(new Error("mystery"), { verbose: false });
    expect(out).toMatch(/unexpected error/i);
    expect(out).toMatch(/mystery/);
  });

  it("suggests -v for non-verbose unknown errors", () => {
    const out = formatError(new Error("mystery"), { verbose: false });
    expect(out).toMatch(/Run with -v/);
  });

  it("does NOT suggest -v when the user is already verbose", () => {
    const out = formatError(new Error("mystery"), { verbose: true });
    expect(out).not.toMatch(/Run with -v/);
  });

  it("handles non-Error throwables", () => {
    const out = formatError("a string was thrown", { verbose: false });
    expect(out).toMatch(/unexpected error/i);
    expect(out).toMatch(/a string was thrown/);
  });
});

describe("redact", () => {
  it("returns short strings unchanged", () => {
    expect(redact("feat: x", 80)).toBe("feat: x");
  });

  it("truncates long strings and reports original length", () => {
    const out = redact("a".repeat(100), 10);
    expect(out.startsWith("a".repeat(10))).toBe(true);
    expect(out).toContain("…");
    expect(out).toContain("100 chars");
  });
});
