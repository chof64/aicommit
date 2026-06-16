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
export const RETRY_DELAY_MS = 3_000;
export const MAX_RETRIES = 1;

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
    throw HttpApiError.fromResponse(response.status, response.statusText, bodySnippet);
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
      const category =
        err instanceof TimeoutError || (err instanceof Error && err.name === "AbortError")
          ? "timeout"
          : err instanceof Error && "category" in err
            ? ((err as { category?: string }).category ?? "unknown")
            : "unknown";
      logVerbose(
        `Retry attempt ${attempt + 1}/${MAX_RETRIES + 1} failed (${category}): ${err instanceof Error ? err.message : String(err)}`,
      );

      // Decide retry purely from the error itself. The `shouldRetry` flag
      // is set by the error's own constructor — for the API path that
      // means `fromResponse` (transient 5xx only) and `NetworkError`.
      const retriable =
        err instanceof NetworkError ||
        (err instanceof HttpApiError && err.shouldRetry) ||
        // Raw AbortError never made it through to callOnce's catch — but
        // be defensive: if it surfaces here, treat as a one-shot timeout.
        (err instanceof Error && err.name === "AbortError" && attempt < MAX_RETRIES);
      if (!retriable) throw err;

      if (attempt < MAX_RETRIES) {
        logWarning(
          `API request failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}, ${category}), retrying in ${RETRY_DELAY_MS / 1000}s...`,
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
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
