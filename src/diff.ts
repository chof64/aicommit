/**
 * Hunk-aware diff truncation. Reduces a `git diff --cached` payload to fit
 * within a character budget while preserving file names, hunk headers, and
 * the most informative lines of each hunk.
 *
 * The goal is not a faithful diff — the model only needs enough context to
 * write a one-line conventional commit message. We keep file paths and the
 * first/last few context lines of each hunk so the model can still see the
 * area of the change, even when large hunks are collapsed.
 *
 * Pure function: no I/O, no side effects, deterministic. Hand-rolled
 * parser — no new dependency.
 */

export const DEFAULT_MAX_DIFF_BYTES = 60_000;
/**
 * Number of unchanged context lines to keep around each +/- block.
 * Tuned for the token-aware path: keeping every +/- line plus a small
 * context window is enough signal to summarize the change.
 */
export const DEFAULT_CONTEXT_LINES = 2;
/** Per-request share of `contextTokens` spent on the diff. Leaves room for the prompt, stat header, and output. */
export const DIFF_TOKENS_RATIO = 0.75;
/** Hard floor on the diff budget so tiny contexts still send something meaningful. */
export const MIN_DIFF_BYTES = 4_000;
/** Share of the diff budget reserved for the truncatable diff body (the rest goes to the stat overview). */
const BODY_BUDGET_RATIO = 0.85;
/** Avg bytes/token heuristic for source code (conservative vs. the ~4.3 for prose). */
const BYTES_PER_TOKEN_ESTIMATE = 4;
/** A single hunk may not exceed this share of the total byte budget. */
const HUNK_BUDGET_RATIO = 0.5;
/** A single file may not exceed this share of the total byte budget. */
const FILE_BUDGET_RATIO = 0.3;

export interface TruncateOptions {
  maxBytes?: number;
  contextLines?: number;
}

/** Parse the lines touched by a single `diff --git` entry. */
function parseEntry(lines: string[]): { added: number; deleted: number; isBinary: boolean } {
  let added = 0;
  let deleted = 0;
  let isBinary = false;
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) break;
    if (line.startsWith("Binary files ")) {
      isBinary = true;
      continue;
    }
    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deleted += 1;
  }
  return { added, deleted, isBinary };
}

/**
 * Decode a path as rendered by git's `core.quotePath` (`"..."` form): handle
 * `\n`, `\t`, `\\`, `\"` and `\ooo` octal byte escapes. Unquoted input is
 * returned unchanged. Octal sequences are collected as raw bytes and decoded
 * as UTF-8 so non-ASCII paths (e.g. `a/\303\251.txt`) render correctly.
 */
function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] ?? "";
    if (ch !== "\\") {
      bytes.push((ch.codePointAt(0) ?? 0) & 0xff);
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) {
      bytes.push(ch.codePointAt(0) ?? 0);
      break;
    }
    if (next === "n") {
      bytes.push(10);
      i += 1;
    } else if (next === "t") {
      bytes.push(9);
      i += 1;
    } else if (next === "\\" || next === '"') {
      bytes.push(next.codePointAt(0) ?? 0);
      i += 1;
    } else if (next >= "0" && next <= "3") {
      const digits = inner.slice(i + 1, i + 4);
      const code = Number.parseInt(digits, 8);
      if (digits.length === 3 && !Number.isNaN(code) && code <= 255) {
        bytes.push(code);
        i += 3;
      } else {
        bytes.push(ch.codePointAt(0) ?? 0, next.codePointAt(0) ?? 0);
        i += 1;
      }
    } else {
      bytes.push(ch.codePointAt(0) ?? 0, next.codePointAt(0) ?? 0);
      i += 1;
    }
  }
  return new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
}

/** Path on a `---`/`+++` line. Git appends a trailing tab when the unquoted path itself has trailing whitespace. */
function fileLinePath(rest: string): string {
  const stripped = rest.endsWith("\t") ? rest.slice(0, -1) : rest;
  return unquoteGitPath(stripped);
}

/** Old path from a `Binary files a/X and b/Y differ` line (binary entries carry no `---`/`+++` lines). */
function binaryOldPath(line: string): string {
  const parts = line.slice("Binary files ".length).split(" and ");
  const old = parts[0] ?? "";
  if (old === "/dev/null") return unquoteGitPath(parts[1] ?? "");
  return unquoteGitPath(old);
}

/**
 * Best-effort old path of a `diff --git` entry. Prefers the `---`/`+++` file
 * lines — git renders the full path there even when it contains spaces — then
 * the `Binary files` line, and falls back to the header's first token.
 */
function entryOldPath(header: string, entry: string[]): string {
  for (const line of entry) {
    if (line.startsWith("Binary files ")) return binaryOldPath(line);
    if (line.startsWith("--- ") && !line.startsWith("--- /dev/null")) {
      return fileLinePath(line.slice("--- ".length));
    }
    if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) {
      return fileLinePath(line.slice("+++ ".length));
    }
  }
  const first = header.slice("diff --git ".length).split(/\s/)[0] ?? "";
  return unquoteGitPath(first);
}

/** Derived change statistics for a whole diff. */
export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
  hasBinary: boolean;
}

/**
 * Derive per-file change statistics from the unified diff itself, so the
 * model can see the scope of every change even when its body was truncated
 * away. Kept in sync with the diff's own hunk headers — it never runs git.
 */
export function countDiffStats(diff: string): DiffStat {
  const stats: DiffStat = { files: 0, insertions: 0, deletions: 0, hasBinary: false };
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!FILE_HEADER_RE.test(line)) continue;
    stats.files += 1;
    const entry: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? "";
      if (FILE_HEADER_RE.test(next)) break;
      entry.push(next);
    }
    const perFile = parseEntry(entry);
    stats.insertions += perFile.added;
    stats.deletions += perFile.deleted;
    stats.hasBinary = stats.hasBinary || perFile.isBinary;
  }
  return stats;
}

/**
 * Compact multi-line overview of the whole change, rendered before the diff
 * body. Includes binary-file counts and lines-changed per path so a
 * truncated diff still conveys its full scope.
 */
export function buildDiffOverview(diff: string, budget: number): string {
  const stats = countDiffStats(diff);
  if (stats.files === 0) return "";
  const label =
    `${stats.files} file${stats.files === 1 ? "" : "s"} changed, ` +
    `${stats.insertions} insertion${stats.insertions === 1 ? "" : "s"}(+), ` +
    `${stats.deletions} deletion${stats.deletions === 1 ? "" : "s"}(-)`;
  const statsLines = [label];

  let i = 0;
  const lines = diff.split("\n");
  while (i < lines.length) {
    if (!FILE_HEADER_RE.test(lines[i] ?? "")) {
      i += 1;
      continue;
    }
    const header = lines[i] ?? "";
    const entry: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const next = lines[j] ?? "";
      if (FILE_HEADER_RE.test(next)) break;
      entry.push(next);
    }
    const perFile = parseEntry(entry);
    const path = entryOldPath(header, entry);
    const suffix = perFile.isBinary ? " (binary)" : "";
    const details = `  ${path}: +${perFile.added}/-${perFile.deleted}${suffix}`;
    if (statsLines.join("\n").length + details.length + 1 <= budget) {
      statsLines.push(details);
    }
    i = j;
  }
  return statsLines.join("\n");
}

/**
 * Proactive byte budget derived from the model's context window, so the
 * first request never overflows. Guards against absurd config values by
 * clamping the ratio to the default 60 KB cap.
 */
export function computeDiffBudget(contextTokens: number): number {
  const bytes = contextTokens * DIFF_TOKENS_RATIO * BYTES_PER_TOKEN_ESTIMATE;
  return Math.min(Math.max(Math.floor(bytes), MIN_DIFF_BYTES), DEFAULT_MAX_DIFF_BYTES);
}

/** Split the full diff into a scope overview plus a size-bounded body. */
export interface DiffPayload {
  /** Always derived from the *full* diff, so a truncated body still conveys total scope. */
  overview: string;
  /** The diff body, truncated to fit the budget. */
  body: string;
}

/**
 * Build the two halves of the model payload for a given token-derived byte
 * budget. The overview is always computed from the full diff; the body is
 * hunk-truncated when it exceeds its share of the budget.
 */
export function buildDiffPayload(diff: string, budget: number): DiffPayload {
  const bodyBudget = Math.floor(budget * BODY_BUDGET_RATIO);
  const overviewBudget = Math.max(budget - bodyBudget, 0);
  return {
    overview: buildDiffOverview(diff, overviewBudget),
    body: truncateDiff(diff, { maxBytes: bodyBudget }),
  };
}

const FILE_HEADER_RE = /^diff --git /;
const OLD_FILE_RE = /^--- /;
const NEW_FILE_RE = /^\+\+\+ /;
const HUNK_HEADER_RE = /^@@ /;
/** Lines inside a hunk: +, -, space (context), or `\` (no-newline marker). */
const HUNK_LINE_RE = /^[-+ \\]/;

interface TruncationStats {
  /** Bytes saved by the truncation. */
  droppedBytes: number;
  /** Number of hunk-internal lines that were omitted. */
  droppedLines: number;
  /** Number of whole hunks omitted (file-level overflow). */
  droppedHunks: number;
}

/**
 * Truncate a unified diff to fit within `maxBytes`. Returns the original
 * string unchanged when it already fits. When truncation occurs, the
 * returned string always ends with a small marker note so the model knows
 * it is seeing a partial diff.
 */
export function truncateDiff(diff: string, opts: TruncateOptions = {}): string {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const contextLines = opts.contextLines ?? DEFAULT_CONTEXT_LINES;

  if (diff.length <= maxBytes) return diff;

  const lines = diff.split("\n");
  const out: string[] = [];
  let fileCount = 0;
  // Conservative upper bound on file count while parsing — used to split
  // per-file budgets. We bump it as we see new file headers.
  let runningFileCount = 1;
  const fileBudget = Math.floor(maxBytes * FILE_BUDGET_RATIO);
  const hunkBudget = Math.floor(maxBytes * HUNK_BUDGET_RATIO);
  const stats: TruncationStats = { droppedBytes: 0, droppedLines: 0, droppedHunks: 0 };

  // Track the file's accumulated output bytes since the last `diff --git`,
  // so we can drop subsequent hunks when a file already exceeded its share.
  let fileBytes = 0;
  let fileOverflowed = false;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (FILE_HEADER_RE.test(line)) {
      runningFileCount = Math.max(runningFileCount, fileCount + 1);
      fileCount = runningFileCount;
      fileBytes = 0;
      fileOverflowed = false;
      out.push(line);
      i += 1;
      continue;
    }
    if (OLD_FILE_RE.test(line) || NEW_FILE_RE.test(line)) {
      out.push(line);
      i += 1;
      continue;
    }
    if (HUNK_HEADER_RE.test(line)) {
      // Per-hunk budget split across the files we have seen so far.
      const perHunk = Math.floor(hunkBudget / Math.max(fileCount, 1));
      const hunkLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && (HUNK_LINE_RE.test(lines[j] ?? "") || (lines[j] ?? "") === "")) {
        hunkLines.push(lines[j] ?? "");
        j += 1;
      }
      const hunkBytes = hunkLines.reduce((n, l) => n + l.length + 1, 0);

      if (fileOverflowed) {
        // Drop the whole hunk; keep its header for context.
        out.push(line);
        stats.droppedHunks += 1;
        stats.droppedBytes += hunkBytes;
        i = j;
        continue;
      }

      if (hunkBytes <= perHunk) {
        out.push(line, ...hunkLines);
        fileBytes += line.length + 1 + hunkBytes;
      } else {
        const trimmed = trimHunk(hunkLines, contextLines, perHunk);
        out.push(line, ...trimmed.lines);
        const tail = `\n... (${trimmed.droppedLines} more lines, ${trimmed.droppedBytes} bytes omitted in this hunk) ...`;
        out.push(tail);
        stats.droppedLines += trimmed.droppedLines;
        stats.droppedBytes += trimmed.droppedBytes;
        fileBytes += line.length + 1 + trimmed.lines.join("\n").length + tail.length + 1;
      }

      if (fileBytes >= fileBudget) {
        fileOverflowed = true;
      }
      i = j;
      continue;
    }
    // Body line (e.g. `index abc..def`, `Binary files ...`, `similarity index N%`).
    // Keep these header-style lines — they're cheap and informative.
    out.push(line);
    i += 1;
  }

  let result = out.join("\n");
  if (result.length > maxBytes) {
    const truncatedNote = `\n... (truncated to fit model context window; ${stats.droppedBytes} bytes and ${stats.droppedLines} lines omitted across ${stats.droppedHunks} hunks) ...`;
    result = `${result.slice(0, Math.max(0, maxBytes - truncatedNote.length))}${truncatedNote}`;
  }
  return result;
}

interface HunkTrimResult {
  lines: string[];
  droppedLines: number;
  droppedBytes: number;
}

/**
 * Keep the first `contextLines` and last `contextLines` interior lines of
 * a hunk, plus every `+`/`-` line (those are the actual signal). If the
 * kept set still exceeds `perHunk` bytes, take from the front of the
 * context window symmetrically.
 */
function trimHunk(hunkLines: string[], contextLines: number, perHunk: number): HunkTrimResult {
  const kept: string[] = [];
  const head = hunkLines.slice(0, contextLines);
  const tail = hunkLines.slice(Math.max(0, hunkLines.length - contextLines));
  const addRem = hunkLines.filter((l) => l.startsWith("+") || l.startsWith("-"));
  kept.push(...head, ...addRem, ...tail);

  // If still too big, drop the trailing context first, then the head.
  // Use an iterative slice-based shrink so we never mutate the array in
  // place (mutating with `pop()` triggers biome's `useConst` lint).
  let working = dedupePreservingOrder(kept);
  let bytes = working.reduce((n, l) => n + l.length + 1, 0);
  while (bytes > perHunk && working.length > 1) {
    const removed = working[working.length - 1];
    working = working.slice(0, -1);
    if (removed !== undefined) bytes -= removed.length + 1;
  }
  const droppedLines = hunkLines.length - working.length;
  const droppedBytes = hunkLines.reduce((n, l) => n + l.length + 1, 0) - bytes;
  return { lines: working, droppedLines, droppedBytes };
}

/**
 * Keep the first occurrence of each line, preserving order. Strips exact
 * duplicates introduced by the head+addRem+tail join (`+`/`-` lines near
 * the boundary can otherwise appear twice).
 */
function dedupePreservingOrder(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    if (seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
}
