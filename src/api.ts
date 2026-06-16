import { HttpApiError, NetworkError, ParseError, TimeoutError } from "./errors.js";
import { logVerbose, logWarning } from "./logger.js";

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

/** Endpoint and timing constants for the opencode.ai zen API. */
export const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
export const MODEL = "big-pickle";
export const TIMEOUT_MS = 60_000;

/** Total retry budget: 1 initial attempt + MAX_RETRIES retries. */
export const MAX_RETRIES = 3;
/** First retry waits this long; each subsequent retry doubles, capped at RETRY_MAX_MS. */
export const RETRY_BASE_MS = 2_000;
export const RETRY_MAX_MS = 30_000;

/** System prompt that frames the model as a commit-message generator. */
export const SYSTEM_PROMPT =
  "You are a helpful assistant that generates commit messages in conventional commit format (<type>: <description>). Output ONLY the commit message. No explanation, no markdown, no code blocks.";

/** User-prompt tail appended after any hint prefix. */
export const USER_PROMPT_TAIL =
  "Given these staged changes, output ONLY the commit message in conventional commit format (<type>: <description>). No explanation, no markdown, no code blocks.";

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  // HTTP-date form: rare, skip with a verbose log. The user can extend if needed.
  logVerbose(`Ignoring non-numeric Retry-After header: ${value}`);
  return undefined;
}

/** One raw API call. Throws typed errors; never calls process.exit. */
async function callOnce(
  messages: ChatMessage[],
  apiKey: string,
  signal: AbortSignal,
): Promise<ApiResponse> {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ model: MODEL, messages, stream: false }),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError(`Request timed out after ${TIMEOUT_MS / 1000}s`, { cause: err });
    }
    throw new NetworkError("Network error reaching the API", { cause: err });
  }

  if (!response.ok) {
    let bodySnippet = "";
    try {
      const text = await response.text();
      bodySnippet = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    } catch {
      // Body read failed; statusText is enough.
    }
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    throw HttpApiError.fromResponse(
      response.status,
      response.statusText,
      bodySnippet,
      retryAfterMs,
    );
  }

  try {
    return (await response.json()) as ApiResponse;
  } catch (err) {
    throw new ParseError("Invalid JSON in API response", { cause: err });
  }
}

/** Call the API with up to MAX_RETRIES retries. Skips retries for non-transient categories. */
export async function callWithRetry(messages: ChatMessage[], apiKey: string): Promise<ApiResponse> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      logVerbose("Sending request to API...");
      const data = await callOnce(messages, apiKey, controller.signal);
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

      // Decide retry purely from the error itself. `shouldRetry` is set by
      // the error's own constructor — currently: 429, 408, 5xx, NetworkError.
      const retriable =
        err instanceof NetworkError ||
        (err instanceof HttpApiError && err.shouldRetry) ||
        (err instanceof Error && err.name === "AbortError");
      if (!retriable) throw err;
      if (attempt >= MAX_RETRIES) break;

      const delay = backoffMs(attempt, err instanceof HttpApiError ? err.retryAfterMs : undefined);
      logWarning(
        `API request failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}, ${category}), retrying in ${Math.round(delay / 1000)}s...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
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
