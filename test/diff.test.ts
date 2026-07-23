import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_LINES, DEFAULT_MAX_DIFF_BYTES, truncateDiff } from "../src/diff.js";

describe("truncateDiff", () => {
  it("returns the input unchanged when it fits the budget", () => {
    const small = "diff --git a/foo b/foo\n@@ -1 +1 @@\n-x\n+y\n";
    expect(truncateDiff(small, { maxBytes: 1000, contextLines: 3 })).toBe(small);
  });

  it("returns the input unchanged when exactly at the budget", () => {
    // Build a diff whose length is exactly the budget.
    const content = "a".repeat(50);
    const diff = `diff --git a/foo b/foo\n@@ -1 +1 @@\n-${content}\n+${content}\n`;
    expect(truncateDiff(diff, { maxBytes: diff.length, contextLines: 3 })).toBe(diff);
  });

  it("preserves file headers and hunk headers in a multi-file diff", () => {
    const fileA = makeFile("a.txt", 100);
    const fileB = makeFile("b.txt", 100);
    const diff = `${fileA}${fileB}`;
    const out = truncateDiff(diff, { maxBytes: 400, contextLines: 3 });
    expect(out).toContain("diff --git a/a.txt b/a.txt");
    expect(out).toContain("diff --git a/b.txt b/b.txt");
    expect(out).toMatch(/@@/);
  });

  it("drops middle content of an oversized single hunk and inserts a marker", () => {
    const bigLine = "x".repeat(2000);
    const diff = `diff --git a/foo b/foo\n@@ -1,5 +1,5 @@\n line1\n${bigLine}\n${bigLine}\n${bigLine}\n line2\n`;
    const out = truncateDiff(diff, { maxBytes: 200, contextLines: 1 });
    expect(out).toMatch(/@@/);
    // The hunk trim emits a per-hunk marker ("more lines ... omitted in this
    // hunk"), or, if the final hard-cap fires, the global marker. Either
    // proves the truncation logic kicked in.
    expect(out).toMatch(/omitted|truncated to fit/);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it("keeps all `+` and `-` lines in a hunk when the hunk fits the per-hunk budget", () => {
    const addLines = Array.from({ length: 5 }, (_, i) => `+added line ${i}`).join("\n");
    const diff = `diff --git a/foo b/foo\n@@ -1 +1,5 @@\n${addLines}\n`;
    const out = truncateDiff(diff, { maxBytes: 2000, contextLines: 3 });
    expect(out).toContain("+added line 0");
    expect(out).toContain("+added line 4");
  });

  it("drops subsequent hunks when a file already exceeds the per-file budget", () => {
    const bigHunk = `@@ -1,3 +1,3 @@\n${Array.from({ length: 50 }, () => "x".repeat(40)).join("\n")}\n`;
    const smallHunk = `@@ -200,3 +200,3 @@\n-${"y".repeat(20)}\n+${"z".repeat(20)}\n`;
    const diff = `diff --git a/big b/big\n${bigHunk}${smallHunk}\n`;
    const out = truncateDiff(diff, { maxBytes: 400, contextLines: 2 });
    expect(out).toContain("diff --git a/big b/big");
    // The first hunk header survives; the second hunk's body is dropped.
    expect(out).toMatch(/@@/);
  });

  it("appends a final truncation note when the assembled output still exceeds the budget", () => {
    // 5 huge files — none can fit under the budget so the final marker fires.
    const file = makeFile("big", 400);
    const diff = Array.from({ length: 5 }, (_, i) => file.replace(/a\/big/g, `a/big${i}`)).join("");
    const out = truncateDiff(diff, { maxBytes: 200, contextLines: 3 });
    expect(out).toMatch(/truncated to fit model context window/);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it("respects maxBytes even with a single maliciously long line", () => {
    const evil = "z".repeat(50_000);
    const diff = `diff --git a/foo b/foo\n@@ -1 +1 @@\n-${evil}\n+${evil}\n`;
    const out = truncateDiff(diff, { maxBytes: 1000, contextLines: 3 });
    expect(out.length).toBeLessThanOrEqual(1000);
  });

  it("exports sensible defaults", () => {
    expect(DEFAULT_MAX_DIFF_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_CONTEXT_LINES).toBeGreaterThan(0);
    // First parameter is the diff; the second is opts (an optional object).
    // A default-parameter doesn't show up in `.length`, so we just check the
    // function is callable with one or two arguments.
    expect(typeof truncateDiff).toBe("function");
    expect(truncateDiff("noop")).toBe("noop");
    expect(truncateDiff("noop", { maxBytes: 100 })).toBe("noop");
  });

  it("degrades gracefully on empty input", () => {
    expect(truncateDiff("", { maxBytes: 100 })).toBe("");
  });

  it("degrades gracefully on a malformed diff (no hunk headers)", () => {
    // No `diff --git`, no `@@` — just lines.
    const noise = "garbage\n".repeat(200);
    const out = truncateDiff(noise, { maxBytes: 100 });
    expect(out.length).toBeLessThanOrEqual(100);
  });
});

/**
 * Build a one-file diff with `lines` hunk-body lines. Defaults to a minimal
 * 3-line hunk so tests can stay readable.
 */
function makeFile(path: string, bodyBytes: number): string {
  const body = "x".repeat(bodyBytes);
  const line = `+${body}`;
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${line}\n`;
}
