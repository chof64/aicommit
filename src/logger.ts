/**
 * Tiny logging helpers. `log` is user-facing progress on stdout; `logVerbose`
 * is debug-level info on stderr; `logError` is for failures on stderr.
 */
let verbose = false;

export function setVerbose(value: boolean): void {
  verbose = value;
}

export function isVerbose(): boolean {
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
