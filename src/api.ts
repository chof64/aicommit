import {
  ENDPOINT,
  MAX_RETRIES,
  MODEL,
  RETRY_DELAY_MS,
  SYSTEM_PROMPT,
  TIMEOUT_MS,
  USER_AGENT,
  USER_PROMPT_TAIL,
} from "./config.js";
import { logError, logVerbose } from "./logger.js";
import type { ApiResponse, ChatMessage } from "./types.js";

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

/** One raw API call. Throws on non-2xx, network failure, or abort. */
async function callOnce(
  messages: ChatMessage[],
  apiKey: string,
  signal: AbortSignal,
): Promise<ApiResponse> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ model: MODEL, messages, stream: false }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as ApiResponse;
}

/** Call the API with one automatic retry on failure. Exits on terminal failure. */
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
      logVerbose(`Retry attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${err}`);

      if (attempt < MAX_RETRIES) {
        logError(
          `API request failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${RETRY_DELAY_MS / 1000}s...`,
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  logError(`Error: failed to generate commit message: ${lastError}`);
  process.exit(1);
}

/** Extract the commit message text from the API response. Exits on bad shape. */
export function parseCommitMessage(data: ApiResponse): string {
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content || content === "null") {
    logError("Error: invalid API response format: empty content");
    process.exit(1);
  }
  logVerbose(`Parsed commit message: ${content}`);
  return content;
}
