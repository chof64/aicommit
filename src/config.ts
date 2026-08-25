/**
 * Provider configuration resolved from environment variables.
 *
 * Defaults target opencode.ai zen; any OpenAI-compatible endpoint works by
 * overriding `AICOMMIT_BASE_URL` / `AICOMMIT_MODEL`. The API key is optional:
 * zen's `big-pickle` accepts anonymous requests, while other providers may
 * still require one.
 */
/** Resolved connection settings for the OpenAI-compatible endpoint. */
export interface Config {
  /** Root URL — the AI SDK appends `/chat/completions`. */
  baseURL: string;
  /** Sent as `Authorization: Bearer <key>` when set. */
  apiKey?: string;
  model: string;
  /** Model context-window size in tokens. Drives proactive diff budgeting. */
  contextTokens: number;
}

/** OpenAI-compatible base URL for opencode.ai zen. */
export const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";
/** Default model served by the zen endpoint. */
export const DEFAULT_MODEL = "big-pickle";
/**
 * Assumed context window for the default endpoint/model. Conservative: it
 * keeps the first request comfortably inside the window of small local
 * models (e.g. Ollama) while staying configurable for larger ones.
 */
export const DEFAULT_CONTEXT_TOKENS = 16_000;
/** Values below this floor are treated as misconfigured and fall back to the default. */
const MIN_CONTEXT_TOKENS = 1_024;

/** Parse `AICOMMIT_CONTEXT_TOKENS`; fall back to the default when unset or invalid. */
function parseContextTokens(value: string | undefined): number {
  const parsed = Number(value?.trim());
  if (Number.isFinite(parsed) && parsed >= MIN_CONTEXT_TOKENS) {
    return Math.floor(parsed);
  }
  return DEFAULT_CONTEXT_TOKENS;
}

/**
 * Resolve provider settings from `env` (defaults to `process.env`).
 * `AICOMMIT_*` variables win; `OPENCODE_API_KEY` remains as a legacy
 * fallback for the key only. All settings are optional — unset values
 * fall back to the zen defaults.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    baseURL: env.AICOMMIT_BASE_URL?.trim() || DEFAULT_BASE_URL,
    apiKey: env.AICOMMIT_API_KEY?.trim() || env.OPENCODE_API_KEY?.trim() || undefined,
    model: env.AICOMMIT_MODEL?.trim() || DEFAULT_MODEL,
    contextTokens: parseContextTokens(env.AICOMMIT_CONTEXT_TOKENS),
  };
}
