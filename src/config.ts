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
}

/** OpenAI-compatible base URL for opencode.ai zen. */
export const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";
/** Default model served by the zen endpoint. */
export const DEFAULT_MODEL = "big-pickle";

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
  };
}
