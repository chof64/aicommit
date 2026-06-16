/**
 * Tiny logging helpers. `log` is user-facing progress on stdout; `logVerbose`
 * is debug-level info on stderr; `logError` is for failures on stderr.
 */
let verbose = false;

export function setVerbose(value: boolean): void {
  verbose = value;
}

/** Reset module state. Call from `run()` so test invocations don't leak the previous call's verbose flag. */
export function reset(): void {
  verbose = false;
}

/** Read the current verbose flag. Used by the central error funnel. */
export function getVerbose(): boolean {
  return verbose;
}

export function log(msg: string): void {
  process.stdout.write(`→ ${msg}\n`);
}

export function logVerbose(msg: string): void {
  if (verbose) {
    process.stderr.write(`→ [VERBOSE] ${msg}\n`);
  }
}

export function logError(msg: string): void {
  process.stderr.write(`${msg}\n`);
}
