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
/** Number of unchanged context lines to keep around each +/- block. */
export const DEFAULT_CONTEXT_LINES = 3;
/** A single hunk may not exceed this share of the total byte budget. */
const HUNK_BUDGET_RATIO = 0.5;
/** A single file may not exceed this share of the total byte budget. */
const FILE_BUDGET_RATIO = 0.3;

export interface TruncateOptions {
  maxBytes?: number;
  contextLines?: number;
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
