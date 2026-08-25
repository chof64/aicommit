import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, generateText } from "ai";
import type { Config } from "./config.js";
import {
  buildDiffPayload,
  computeDiffBudget,
  DEFAULT_CONTEXT_LINES,
  DEFAULT_MAX_DIFF_BYTES,
  truncateDiff,
} from "./diff.js";
import { HttpApiError, NetworkError, ParseError, TimeoutError } from "./errors.js";
import { logVerbose, logWarning } from "./logger.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./pkg.js";

export {
  buildDiffPayload,
  computeDiffBudget,
  DEFAULT_CONTEXT_LINES,
  DEFAULT_MAX_DIFF_BYTES,
  truncateDiff,
};

export const TIMEOUT_MS = 60_000;

/** Total retry budget: 1 initial attempt + MAX_RETRIES retries. */
export const MAX_RETRIES = 3;
/** First retry waits this long; each subsequent retry doubles, capped at RETRY_MAX_MS. */
export const RETRY_BASE_MS = 2_000;
export const RETRY_MAX_MS = 30_000;
/** Hard cap on cumulative wait time across all retries. Clamps per-retry delays that would push us over. */
export const MAX_TOTAL_WAIT_MS = 30_000;

/** System prompt that frames the model as a commit-message generator. */
export const SYSTEM_PROMPT =
  "You are a helpful assistant that generates commit messages in conventional commit format (<type>: <description>). Output ONLY the commit message. No explanation, no markdown, no code blocks.";

/** User-prompt tail appended after any hint prefix. */
export const USER_PROMPT_TAIL =
  "Given these staged changes, output ONLY the commit message in conventional commit format (<type>: <description>). No explanation, no markdown, no code blocks.";

export const USER_AGENT = `${PACKAGE_NAME}/${PACKAGE_VERSION}`;

/** Build the user prompt: optional hint prefix, instruction tail, then the diff. */
export function buildUserPrompt(hint: string, diff: string): string {
  const hintPrefix = hint ? `Context/hint: ${hint} ` : "";
  return `${hintPrefix}${USER_PROMPT_TAIL}\n\n${diff}`;
}

/**
 * Compose the full user message for a given byte budget: a scope overview
 * (always from the full diff) followed by the size-bounded diff body. The
 * overview prefix is dropped entirely when there is nothing to show.
 */
function buildUserContent(hint: string, diff: string, budget: number): string {
  const { overview, body } = buildDiffPayload(diff, budget);
  const composed = overview ? `${overview}\n\n${body}` : body;
  return buildUserPrompt(hint, composed);
}

/** Truncate a string for safe verbose logging. */
export function redact(text: string, max = 80): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (${text.length} chars)`;
}

/**
 * Compute the delay before the next retry. `attempt` is 0-based:
 * attempt 0 → RETRY_BASE_MS, attempt 1 → RETRY_BASE_MS*2, etc., capped at
 * RETRY_MAX_MS. If `retryAfterMs` is set (parsed from a `Retry-After`
 * header), it overrides the computed value.
 */
export function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && retryAfterMs >= 0) return retryAfterMs;
  return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
}

/** Parse a `Retry-After` header. Returns ms, or undefined if absent/unparseable. */
function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  // HTTP-date form: rare, skip with a verbose log. The user can extend if needed.
  logVerbose(`Ignoring non-numeric Retry-After header: ${value}`);
  return undefined;
}

/** Map an AI SDK / transport failure onto our typed error hierarchy. */
function mapSdkError(err: unknown): never {
  if (err instanceof Error && err.name === "AbortError") {
    throw new TimeoutError(`Request timed out after ${TIMEOUT_MS / 1000}s`, { cause: err });
  }

  if (APICallError.isInstance(err)) {
    // Successful HTTP status but unparseable body — same as the old response.json() path.
    if (err.statusCode === 200) {
      throw new ParseError("Invalid JSON in API response", { cause: err.cause ?? err });
    }

    const status = err.statusCode ?? 0;
    const statusText = err.message || "Error";
    const body = err.responseBody ?? "";
    const bodySnippet = body.length > 200 ? `${body.slice(0, 200)}…` : body;
    const retryAfterMs = parseRetryAfter(err.responseHeaders?.["retry-after"]);
    throw HttpApiError.fromResponse(status, statusText, bodySnippet, retryAfterMs);
  }

  throw new NetworkError("Network error reaching the API", { cause: err });
}

/** Reject empty or placeholder model output before it reaches git commit. */
function validateCommitMessage(text: string): string {
  const message = text.trim();
  if (!message || message === "null") {
    throw new ParseError("Invalid API response: empty or null content");
  }
  return message;
}

/**
 * One API call via the Vercel AI SDK.
 *
 * The system prompt goes through the dedicated `system` parameter — the SDK
 * rejects system roles placed inside `prompt`/`messages` with
 * `InvalidPromptError`. `config.apiKey` may be undefined: opencode.ai zen
 * accepts anonymous requests for `big-pickle`.
 *
 * SDK-level retries are disabled (`maxRetries: 0`) so our custom loop — which
 * honors `Retry-After` headers and a total-wait budget — stays in charge.
 */
async function callOnce(config: Config, prompt: string, signal: AbortSignal): Promise<string> {
  const provider = createOpenAICompatible({
    name: "opencode",
    baseURL: config.baseURL,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  });

  try {
    const { text } = await generateText({
      model: provider.chatModel(config.model),
      system: SYSTEM_PROMPT,
      prompt,
      abortSignal: signal,
      maxRetries: 0,
      headers: { "User-Agent": USER_AGENT },
    });
    return text;
  } catch (err) {
    mapSdkError(err);
  }
}

/**
 * Generate a commit message from the staged `diff`, optionally steered by
 * `hint`. Retries transient failures (429, 408, 5xx, network) with
 * exponential backoff up to {@link MAX_RETRIES}; non-retriable failures throw
 * immediately.
 *
 * The diff is proactively budgeted against the model's context window
 * (`config.contextTokens`) before the first request: the body is hunk-truncated
 * and a scope overview (from the full diff) is prefixed. On the specific 400
 * `context_length_exceeded` error, one automatic retry halves the budget —
 * truncation always re-derives from the source-of-truth `diff`, never from a
 * previously truncated version.
 */
export async function generateCommitMessage(
  config: Config,
  hint: string,
  diff: string,
): Promise<string> {
  let lastError: unknown;
  let elapsedWait = 0;
  let truncationAttempted = false;
  let budget = computeDiffBudget(config.contextTokens);
  let content = buildUserContent(hint, diff, budget);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      logVerbose("Sending request to API...");
      const text = await callOnce(config, content, controller.signal);
      clearTimeout(timer);

      const message = validateCommitMessage(text);
      logVerbose(`Parsed commit message: ${redact(message)}`);
      return message;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      const category = (err as { category?: string }).category ?? "unknown";
      logVerbose(
        `Retry attempt ${attempt + 1}/${MAX_RETRIES + 1} failed (${category}): ${err instanceof Error ? err.message : String(err)}`,
      );

      // Single-shot recovery for context overflow: halve the budget and
      // retry immediately. We skip backoff because the failure is
      // deterministic — waiting won't help. This consumes one of the
      // remaining MAX_RETRIES slots.
      if (err instanceof HttpApiError && err.contextExceeded && !truncationAttempted) {
        truncationAttempted = true;
        budget = Math.floor(budget / 2);
        content = buildUserContent(hint, diff, budget);
        logVerbose(`Diff exceeds context window; retrying once with a budget of ${budget} bytes`);
        logWarning("Diff exceeded model context window; retrying with a smaller diff");
        continue;
      }

      // Decide retry purely from the error itself. `shouldRetry` is set by
      // the error's own constructor — currently: 429, 408, 5xx, NetworkError.
      const retriable =
        err instanceof NetworkError ||
        (err instanceof HttpApiError && err.shouldRetry) ||
        (err instanceof Error && err.name === "AbortError");
      if (!retriable) throw err;
      if (attempt >= MAX_RETRIES) break;

      // Clamp the per-retry delay to whatever fits in the remaining total-wait budget.
      const requested = backoffMs(
        attempt,
        err instanceof HttpApiError ? err.retryAfterMs : undefined,
      );
      const remaining = MAX_TOTAL_WAIT_MS - elapsedWait;
      const delay = Math.min(requested, Math.max(remaining, 0));
      if (delay <= 0) break;

      logWarning(
        `API request failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}, ${category}), retrying in ${Math.round(delay / 1000)}s...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      elapsedWait += delay;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new ParseError("Failed to generate commit message", { cause: lastError });
}
