import { logError, logVerbose } from "./logger.js";

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
