import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, generateText } from "ai";
import { DEFAULT_CONTEXT_LINES, DEFAULT_MAX_DIFF_BYTES, truncateDiff } from "./diff.js";
import { HttpApiError, NetworkError, ParseError, TimeoutError } from "./errors.js";
import { logVerbose, logWarning } from "./logger.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./pkg.js";

export { DEFAULT_CONTEXT_LINES, DEFAULT_MAX_DIFF_BYTES, truncateDiff };

/** A single chat message in the OpenAI-compatible API format. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Minimal shape of the API response we consume. */
export interface ApiResponse {
  choices: Array<{
    message: { content: string };
  }>;
}

/**
 * OpenAI-compatible base URL for opencode.ai zen.
 * Chat completions are served at `${BASE_URL}/chat/completions`.
 */
export const BASE_URL = "https://opencode.ai/zen/v1";
/** Full chat-completions endpoint (kept for docs/compat; AI SDK uses {@link BASE_URL}). */
export const ENDPOINT = `${BASE_URL}/chat/completions`;
export const MODEL = "big-pickle";
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

/** Build the system+user message pair for the chat-completions API. */
export function buildMessages(hintPrompt: string, diff: string): ChatMessage[] {
  const userContent = hintPrompt
    ? `${hintPrompt}${USER_PROMPT_TAIL}\n\n${diff}`
    : `${USER_PROMPT_TAIL}\n\n${diff}`;

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
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

/**
 * One API call via the Vercel AI SDK.
 *
 * The system prompt is split off from the `messages` array and passed via
 * the `system` parameter. The AI SDK >= 5 rejects system messages placed in
 * `messages` with `InvalidPromptError`, so we extract the first `system`
 * message here. Anything else (user/assistant turns) stays in `messages`.
 */
async function callOnce(
  messages: ChatMessage[],
  apiKey: string,
  signal: AbortSignal,
): Promise<ApiResponse> {
  const provider = createOpenAICompatible({
    name: "opencode",
    baseURL: BASE_URL,
    apiKey,
  });

  const systemMsg = messages.find((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  try {
    const { text } = await generateText({
      model: provider.chatModel(MODEL),
      system: systemMsg?.content,
      messages: nonSystemMessages,
      abortSignal: signal,
      // Keep our existing retry policy; avoid stacking SDK retries on top.
      maxRetries: 0,
      headers: { "User-Agent": USER_AGENT },
    });
    return { choices: [{ message: { content: text } }] };
  } catch (err) {
    mapSdkError(err);
  }
}

/**
 * Rebuild the messages array with a truncated diff in place. Preserves all
 * leading non-user messages (e.g. `system`) from the input and replaces
 * the user message with one whose instructions/diff reflect the truncated
 * diff. The hint prefix and instruction tail are reapplied so the model
 * sees the same prompt shape, just with a smaller diff.
 */
function rebuildMessagesWithDiff(
  messages: ChatMessage[],
  hintPrompt: string,
  truncatedDiff: string,
): ChatMessage[] {
  const userContent = `${hintPrompt}${USER_PROMPT_TAIL}\n\n${truncatedDiff}`;
  // Keep any leading non-user messages (e.g. system prompt) so the model
  // sees the same role topology. Then append the new user message.
  const head = messages.filter((m) => m.role !== "user");
  return [...head, { role: "user", content: userContent }];
}

/**
 * Call the API with up to MAX_RETRIES retries. Skips retries for non-transient categories.
 *
 * On the specific 400 `context_length_exceeded` error, attempts a single
 * automatic retry with a truncated diff before falling through to the
 * normal retry policy. This consumes one of the MAX_RETRIES slots but
 * skips backoff (the failure is deterministic, not transient).
 *
 * `originalDiff` is passed alongside `messages` so the retry path can
 * re-truncate from the source-of-truth diff rather than a previously
 * truncated version.
 */
export async function callWithRetry(
  messages: ChatMessage[],
  originalDiff: string,
  hintPrompt: string,
  apiKey: string,
): Promise<ApiResponse> {
  let lastError: unknown;
  let elapsedWait = 0;
  let truncationAttempted = false;
  let workingMessages = messages;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      logVerbose("Sending request to API...");
      const data = await callOnce(workingMessages, apiKey, controller.signal);
      clearTimeout(timer);
      logVerbose("Response received, parsing...");
      return data;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      const category = (err as { category?: string }).category ?? "unknown";
      logVerbose(
        `Retry attempt ${attempt + 1}/${MAX_RETRIES + 1} failed (${category}): ${err instanceof Error ? err.message : String(err)}`,
      );

      // Single-shot recovery for context overflow: truncate the diff and
      // retry immediately. We skip backoff because the failure is
      // deterministic — waiting won't help. This consumes one of the
      // remaining MAX_RETRIES slots.
      if (err instanceof HttpApiError && err.contextExceeded && !truncationAttempted) {
        truncationAttempted = true;
        const truncated = truncateDiff(originalDiff);
        workingMessages = rebuildMessagesWithDiff(workingMessages, hintPrompt, truncated);
        logVerbose(
          `Diff exceeds context window; truncated to ${truncated.length} bytes and retrying once`,
        );
        logWarning("Diff exceeded model context window; retrying with a truncated diff");
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

/** Extract the commit message text from the API response. Throws on bad shape. */
export function parseCommitMessage(data: ApiResponse): string {
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content || content === "null") {
    throw new ParseError("Invalid API response: empty or null content");
  }
  logVerbose(`Parsed commit message: ${redact(content)}`);
  return content;
}
