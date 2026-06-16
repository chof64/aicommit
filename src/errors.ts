/**
 * Typed error hierarchy for aicommit. Every failure mode the CLI can hit
 * has a dedicated class so callers can `instanceof`-check, format
 * consistently via {@link formatError}, and choose not to call
 * `process.exit` themselves — the central funnel in `cli.ts` does that.
 *
 * Exit codes follow the BSD `sysexits.h` convention so shell scripts can
 * distinguish failure modes without parsing stderr. See {@link ExitCode}.
 */

/** sysexits.h-style exit codes. Names map to the BSD defines. */
export const ExitCode = {
  /** Anything not otherwise classified. */
  EX_GENERAL: 1,
  /** Command-line usage error (missing config, non-TTY where required). */
  EX_USAGE: 64,
  /** User-supplied or model-supplied data was wrong. */
  EX_DATAERR: 65,
  /** A required service was unavailable (network, timeout, 5xx, rate-limit). */
  EX_UNAVAILABLE: 69,
  /** User aborted (Ctrl-C, "n" at the prompt). Matches shell convention 128+SIGINT. */
  EX_ABORT: 130,
} as const;
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Coarse category of the failure. Drives retry decisions and exit codes.
 * Distinct from {@link AicommitErrorCode}, which names the *subsystem* that
 * produced the error (git vs api vs config).
 */
export type ErrorCategory =
  | "config"
  | "validation"
  | "git"
  | "auth"
  | "rate-limit"
  | "bad-request"
  | "server"
  | "timeout"
  | "network"
  | "parse"
  | "abort"
  | "unknown";

/** Subsystem that produced the error. Useful for filtering and telemetry. */
export type AicommitErrorCode =
  | "config"
  | "git"
  | "validation"
  | "api"
  | "timeout"
  | "network"
  | "parse"
  | "abort";

/** Base class for every aicommit failure. Never call `process.exit` here. */
export abstract class AicommitError extends Error {
  public readonly code: AicommitErrorCode;
  public readonly category: ErrorCategory;
  public readonly exitCode: ExitCodeValue;
  public readonly shouldRetry: boolean;
  public readonly cause?: unknown;
  public readonly status?: number;
  public readonly suggestions: readonly string[];

  constructor(
    message: string,
    code: AicommitErrorCode,
    category: ErrorCategory,
    opts: {
      cause?: unknown;
      status?: number;
      suggestions?: string[];
      exitCode?: ExitCodeValue;
      shouldRetry?: boolean;
    } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.category = category;
    this.cause = opts.cause;
    this.status = opts.status;
    this.suggestions = Object.freeze([...(opts.suggestions ?? [])]);
    this.exitCode = opts.exitCode ?? ExitCode.EX_GENERAL;
    this.shouldRetry = opts.shouldRetry ?? false;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Env-var miss or non-TTY confirm attempt. */
export class ConfigError extends AicommitError {
  constructor(message: string, opts: { cause?: unknown; suggestions?: string[] } = {}) {
    super(message, "config", "config", { ...opts, exitCode: ExitCode.EX_USAGE });
  }
}

/** Any `git` invocation failure. `cause` is the underlying exec error. */
export class GitError extends AicommitError {
  constructor(message: string, opts: { cause?: unknown; suggestions?: string[] } = {}) {
    super(message, "git", "git", opts);
  }
}

/** Rejecting user/model input that would make the commit unsafe. */
export class ValidationError extends AicommitError {
  constructor(message: string, opts: { cause?: unknown; suggestions?: string[] } = {}) {
    super(message, "validation", "validation", { ...opts, exitCode: ExitCode.EX_DATAERR });
  }
}

/** Non-2xx response from the upstream API. Use {@link HttpApiError.fromResponse}. */
export class HttpApiError extends AicommitError {
  constructor(
    message: string,
    opts: {
      cause?: unknown;
      status: number;
      suggestions?: string[];
      category?: ErrorCategory;
      shouldRetry?: boolean;
    },
  ) {
    super(message, "api", opts.category ?? "unknown", opts);
  }

  /**
   * Build the right HttpApiError for a given response status, with the
   * correct category, retry policy, and suggestions attached at the
   * moment we know the status. Body is read for a short error snippet.
   */
  static fromResponse(status: number, statusText: string, bodySnippet: string): HttpApiError {
    const detail = bodySnippet
      ? `HTTP ${status} ${statusText}: ${bodySnippet}`
      : `HTTP ${status} ${statusText}`;

    if (status === 401 || status === 403) {
      return new HttpApiError(detail, {
        status,
        category: "auth",
        suggestions: ["Verify OPENCODE_API_KEY"],
      });
    }
    if (status === 429) {
      return new HttpApiError(detail, {
        status,
        category: "rate-limit",
        suggestions: ["Wait and retry later", "Check your API quota"],
      });
    }
    if (status === 400) {
      return new HttpApiError(detail, {
        status,
        category: "bad-request",
        suggestions: ["The API rejected the request — try with a smaller diff"],
      });
    }
    if (status === 408) {
      return new HttpApiError(detail, {
        status,
        category: "timeout",
        suggestions: ["Check your network"],
      });
    }
    if (status >= 500) {
      return new HttpApiError(detail, {
        status,
        category: "server",
        shouldRetry: true,
        suggestions: ["The API is having issues — try again shortly"],
      });
    }
    // Unknown status — category stays "unknown", no retry, no hints.
    return new HttpApiError(detail, { status, category: "unknown" });
  }
}

/** Request aborted because it exceeded TIMEOUT_MS, or the user cancelled. */
export class TimeoutError extends AicommitError {
  constructor(message: string, opts: { cause?: unknown; suggestions?: string[] } = {}) {
    super(message, "timeout", "timeout", {
      ...opts,
      status: 408,
      exitCode: ExitCode.EX_UNAVAILABLE,
    });
  }
}

/** Underlying transport (DNS, TCP, TLS) failed. */
export class NetworkError extends AicommitError {
  constructor(message: string, opts: { cause?: unknown; suggestions?: string[] } = {}) {
    super(message, "network", "network", {
      ...opts,
      shouldRetry: true,
      exitCode: ExitCode.EX_UNAVAILABLE,
    });
  }
}

/** Upstream returned a structurally-invalid response. */
export class ParseError extends AicommitError {
  constructor(message: string, opts: { cause?: unknown; suggestions?: string[] } = {}) {
    super(message, "parse", "parse", { ...opts, exitCode: ExitCode.EX_DATAERR });
  }
}

/** User declined the proposed commit (answered "n" at the prompt). */
export class AbortError extends AicommitError {
  constructor(message = "Aborted.") {
    super(message, "abort", "abort", { exitCode: ExitCode.EX_ABORT });
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
  } else if (!verbose) {
    parts.push("→ Run with -v for details");
  }
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
