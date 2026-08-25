import { describe, expect, it } from "vitest";
import {
  buildDiffOverview,
  computeDiffBudget,
  countDiffStats,
  DEFAULT_CONTEXT_LINES,
  DEFAULT_MAX_DIFF_BYTES,
  truncateDiff,
} from "../src/diff.js";

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

describe("countDiffStats", () => {
  it("counts files, insertions, deletions across multiple entries", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,3 @@",
      "-old",
      "+new",
      "+extra",
      "diff --git a/b.txt b/b.txt",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -10,1 +10,1 @@",
      "-x",
      "+y",
    ].join("\n");
    expect(countDiffStats(diff)).toEqual({
      files: 2,
      insertions: 3,
      deletions: 2,
      hasBinary: false,
    });
  });

  it("ignores +/- prefixes on hunk header lines (--- / +++)", () => {
    const diff =
      "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-+literal-plus\n+-literal-minus\n";
    const stats = countDiffStats(diff);
    expect(stats.insertions).toBe(1);
    expect(stats.deletions).toBe(1);
  });

  it("flags hasBinary when a Binary files line is present", () => {
    const diff = "diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n";
    const stats = countDiffStats(diff);
    expect(stats.hasBinary).toBe(true);
    expect(stats.files).toBe(1);
  });

  it("counts hunk body lines that start with +++ or ---", () => {
    const diff = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n-zz\n+++notHeader\n";
    const stats = countDiffStats(diff);
    expect(stats.insertions).toBe(1);
    expect(stats.deletions).toBe(1);
  });

  it("returns a zeroed stat for an empty or headerless diff", () => {
    expect(countDiffStats("")).toEqual({ files: 0, insertions: 0, deletions: 0, hasBinary: false });
    expect(countDiffStats("no headers here\n")).toEqual({
      files: 0,
      insertions: 0,
      deletions: 0,
      hasBinary: false,
    });
  });
});

describe("buildDiffOverview", () => {
  it("lists a total line and per-file stats", () => {
    const diff = "diff --git a/a.txt b/a.txt\n@@ -1,2 +1,3 @@\n-x\n+y\n+z\n";
    const overview = buildDiffOverview(diff, 1000);
    expect(overview).toContain("1 file changed, 2 insertions(+), 1 deletion(-)");
    expect(overview).toContain("a/a.txt: +2/-1");
  });

  it("flags binary files in the per-file line", () => {
    const diff =
      "diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n" +
      "diff --git a/code.ts b/code.ts\n@@ -1 +1 @@\n-x\n+y\n";
    const overview = buildDiffOverview(diff, 2000);
    expect(overview).toContain("2 files changed");
    expect(overview).toMatch(/img\.png: .*\(binary\)/);
    expect(overview).toContain("code.ts: +1/-1");
  });

  it("returns an empty string for a headerless diff", () => {
    expect(buildDiffOverview("not a diff\n", 1000)).toBe("");
  });

  it("renders the full path for filenames containing spaces", () => {
    // Git keeps spaces in unquoted ---/+++ file lines, so the overview must
    // show the whole path, not just the first whitespace-separated token.
    const diff =
      "diff --git a/my file.txt b/my file.txt\n--- a/my file.txt\t\n+++ b/my file.txt\t\n@@ -1 +1 @@\n-x\n+y\n";
    const overview = buildDiffOverview(diff, 1000);
    expect(overview).toContain("a/my file.txt: +1/-1");
  });

  it("unquotes git-escaped quoted paths", () => {
    const diff =
      'diff --git "a/qu\\"ote.txt" "b/qu\\"ote.txt"\n' +
      '--- "a/qu\\"ote.txt"\n+++ "b/qu\\"ote.txt"\n@@ -1 +1 @@\n-x\n+y\n';
    const overview = buildDiffOverview(diff, 1000);
    expect(overview).toContain('a/qu"ote.txt: +1/-1');
  });

  it("decodes octal byte escapes for non-ASCII filenames", () => {
    const diff =
      'diff --git "a/\\303\\251.txt" "b/\\303\\251.txt"\n' +
      '--- "a/\\303\\251.txt"\n+++ "b/\\303\\251.txt"\n@@ -1 +1 @@\n-x\n+y\n';
    const overview = buildDiffOverview(diff, 1000);
    expect(overview).toContain("a/é.txt: +1/-1");
  });

  it("shows the full binary path from the Binary files line", () => {
    const diff =
      "diff --git a/img file.png b/img file.png\n" +
      "Binary files a/img file.png and b/img file.png differ\n";
    const overview = buildDiffOverview(diff, 1000);
    expect(overview).toContain("a/img file.png: +0/-0 (binary)");
  });

  it("renders the new path for a newly-added binary file", () => {
    const diff = "diff --git a/img.png b/img.png\nBinary files /dev/null and b/img.png differ\n";
    const overview = buildDiffOverview(diff, 1000);
    expect(overview).toContain("b/img.png: +0/-0 (binary)");
    expect(overview).not.toContain("differ");
  });

  it("renders the old path for a deleted binary file", () => {
    const diff = "diff --git a/img.png b/img.png\nBinary files a/img.png and /dev/null differ\n";
    const overview = buildDiffOverview(diff, 1000);
    expect(overview).toContain("a/img.png: +0/-0 (binary)");
  });

  it("keeps a new-binary path containing ' and ' intact", () => {
    const diff =
      "diff --git a/foo and bar.png b/foo and bar.png\n" +
      "Binary files /dev/null and b/foo and bar.png differ\n";
    const overview = buildDiffOverview(diff, 1000);
    expect(overview).toContain("b/foo and bar.png: +0/-0 (binary)");
  });

  it("drops per-file lines beyond the budget but keeps the total", () => {
    const diff = makeFile("a/big-name-here.txt", 5) + makeFile("c/other.txt", 5);
    const overview = buildDiffOverview(diff, 60);
    expect(overview).toContain("2 files changed");
    expect(overview.split("\n")).toHaveLength(1);
  });
});

describe("computeDiffBudget", () => {
  it("scales linearly with the context window", () => {
    // 16k context → 16_000 * 0.75 * 4 = 48_000 bytes.
    expect(computeDiffBudget(16_000)).toBe(48_000);
    expect(computeDiffBudget(8_000)).toBe(24_000);
  });

  it("never exceeds the default 60 KB cap", () => {
    expect(computeDiffBudget(200_000)).toBe(DEFAULT_MAX_DIFF_BYTES);
  });

  it("never drops below the MIN floor for tiny contexts", () => {
    expect(computeDiffBudget(1_024)).toBe(4_000);
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
