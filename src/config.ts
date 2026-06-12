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
