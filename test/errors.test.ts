import { describe, expect, it } from "vitest";
import { categorizeError, redact } from "../src/api.js";
import {
  AicommitError,
  ConfigError,
  formatError,
  GitError,
  HttpApiError,
  NetworkError,
  ParseError,
  TimeoutError,
  ValidationError,
} from "../src/errors.js";

describe("error hierarchy", () => {
  it("AicommitError subclasses set the right code and exitCode", () => {
    expect(new ConfigError("c").code).toBe("config");
    expect(new GitError("g").code).toBe("git");
    expect(new ValidationError("v").code).toBe("validation");
    expect(new HttpApiError("h", { status: 500 }).code).toBe("api");
    expect(new TimeoutError("t").code).toBe("timeout");
    expect(new NetworkError("n").code).toBe("network");
    expect(new ParseError("p").code).toBe("parse");
    for (const e of [
      new ConfigError("c"),
      new GitError("g"),
      new ValidationError("v"),
      new HttpApiError("h", { status: 500 }),
      new TimeoutError("t"),
      new NetworkError("n"),
      new ParseError("p"),
    ]) {
      expect(e).toBeInstanceOf(AicommitError);
      expect(e.exitCode).toBe(1);
    }
  });

  it("TimeoutError has status 408", () => {
    expect(new TimeoutError("t").status).toBe(408);
  });

  it("HttpApiError preserves the status", () => {
    expect(new HttpApiError("h", { status: 502 }).status).toBe(502);
  });

  it("cause and suggestions round-trip", () => {
    const cause = new Error("root");
    const e = new GitError("g", { cause, suggestions: ["hint"] });
    expect(e.cause).toBe(cause);
    expect(e.suggestions).toEqual(["hint"]);
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

  it("handles non-Error throwables", () => {
    const out = formatError("a string was thrown", { verbose: false });
    expect(out).toMatch(/unexpected error/i);
    expect(out).toMatch(/a string was thrown/);
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
    expect(categorizeError(new HttpApiError("x", { status: 503 })).category).toBe("server");
  });

  it("returns timeout for TimeoutError, AbortError, and 408", () => {
    expect(categorizeError(new TimeoutError("t")).category).toBe("timeout");
    const abort = new Error("a");
    abort.name = "AbortError";
    expect(categorizeError(abort).category).toBe("timeout");
    expect(categorizeError(new HttpApiError("x", { status: 408 })).category).toBe("timeout");
  });

  it("returns network for TypeError and NetworkError", () => {
    expect(categorizeError(new TypeError("ECONNREFUSED")).category).toBe("network");
    expect(categorizeError(new NetworkError("n")).category).toBe("network");
  });

  it("returns unknown for everything else", () => {
    expect(categorizeError(new Error("weird")).category).toBe("unknown");
    expect(categorizeError("string error").category).toBe("unknown");
  });

  it("every categorization carries non-empty suggestions", () => {
    const cases: unknown[] = [
      new HttpApiError("x", { status: 401 }),
      new HttpApiError("x", { status: 429 }),
      new HttpApiError("x", { status: 400 }),
      new HttpApiError("x", { status: 500 }),
      new HttpApiError("x", { status: 408 }),
      new TimeoutError("t"),
      new TypeError("e"),
      new Error("e"),
      "string",
    ];
    for (const c of cases) {
      const { suggestions } = categorizeError(c);
      expect(suggestions.length).toBeGreaterThan(0);
    }
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
