/**
 * Typed error hierarchy for aicommit. Every failure mode the CLI can hit
 * has a dedicated class so callers can `instanceof`-check, format
 * consistently via {@link formatError}, and choose not to call
 * `process.exit` themselves — the central funnel in `cli.ts` does that.
 */

export type AicommitErrorCode =
  | "config"
  | "git"
  | "validation"
  | "api"
  | "timeout"
  | "network"
  | "parse";

/** Base class for every aicommit failure. Never call `process.exit` here. */
export abstract class AicommitError extends Error {
  public readonly code: AicommitErrorCode;
  public readonly exitCode: number = 1;
  public readonly cause?: unknown;
  public readonly status?: number;
  public readonly suggestions: readonly string[];

  constructor(
    message: string,
    code: AicommitErrorCode,
    opts: { cause?: unknown; status?: number; suggestions?: string[] } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.cause = opts.cause;
    this.status = opts.status;
    this.suggestions = Object.freeze([...(opts.suggestions ?? [])]);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Env-var miss or non-TTY confirm attempt. */
export class ConfigError extends AicommitError {
  constructor(message: string, opts: { cause?: unknown; suggestions?: string[] } = {}) {
    super(message, "config", opts);
  }
}

/** Any `git` invocation failure. `cause` is the underlying exec error. */
export class GitError extends AicommitError {
  constructor(message: string, opts: { cause?: unknown; suggestions?: string[] } = {}) {
    super(message, "git", opts);
  }
}

/** Rejecting user/model input that would make the commit unsafe. */
export class ValidationError extends AicommitError {
  constructor(message: string, opts: { cause?: unknown; suggestions?: string[] } = {}) {
    super(message, "validation", opts);
  }
}

/** Non-2xx response from the upstream API. */
export class HttpApiError extends AicommitError {
  constructor(message: string, opts: { cause?: unknown; status: number; suggestions?: string[] }) {
    super(message, "api", opts);
  }
}

/** Request aborted because it exceeded TIMEOUT_MS. */
export class TimeoutError extends AicommitError {
  constructor(message: string, opts: { cause?: unknown; suggestions?: string[] } = {}) {
    super(message, "timeout", { ...opts, status: 408 });
  }
}

/** Underlying transport (DNS, TCP, TLS) failed. */
export class NetworkError extends AicommitError {
  constructor(message: string, opts: { cause?: unknown; suggestions?: string[] } = {}) {
    super(message, "network", opts);
  }
}

/** Upstream returned a structurally-invalid response. */
export class ParseError extends AicommitError {
  constructor(message: string, opts: { cause?: unknown; suggestions?: string[] } = {}) {
    super(message, "parse", opts);
  }
}

export type ErrorFormatOptions = { verbose?: boolean };

/**
 * Render any error into a 3-block, single-string user message:
 *   line 1:   `Error: <human title>`
 *   line 2..N: body (message). In verbose mode, appends cause details.
 *   last:     one `→ <suggestion>` per suggestion.
 *
 * Unknown errors are wrapped in a generic "unexpected error" title so the
 * funnel never has to special-case them.
 */
export function formatError(err: unknown, opts: ErrorFormatOptions = {}): string {
  const verbose = opts.verbose === true;

  if (err instanceof AicommitError) {
    const parts: string[] = [`Error: ${err.message}`];
    if (verbose && err.cause !== undefined) {
      parts.push(`Cause: ${stringifyCause(err.cause)}`);
    }
    for (const s of err.suggestions) parts.push(`→ ${s}`);
    return parts.join("\n");
  }

  const cause = err instanceof Error ? err.message : String(err);
  const parts: string[] = ["Error: unexpected error", cause];
  if (verbose && err instanceof Error && err.stack) {
    parts.push(err.stack.split("\n").slice(0, 3).join("\n"));
  }
  parts.push("→ Run with -v for details");
  return parts.join("\n");
}

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}
