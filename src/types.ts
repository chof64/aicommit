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

/** Parsed CLI options (subset of commander's parsed result). */
export interface CliOptions {
  dryRun?: boolean;
  verbose?: boolean;
}
