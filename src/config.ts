/**
 * Provider configuration resolved from environment variables.
 *
 * Defaults target opencode.ai zen; any OpenAI-compatible endpoint works by
 * overriding `AICOMMIT_BASE_URL` / `AICOMMIT_MODEL`.
 */
import { ConfigError } from "./errors.js";

/** Resolved connection settings for the OpenAI-compatible endpoint. */
export interface Config {
  /** Root URL — the AI SDK appends `/chat/completions`. */
  baseURL: string;
  apiKey: string;
  model: string;
}

/** OpenAI-compatible base URL for opencode.ai zen. */
export const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";
/** Default model served by the zen endpoint. */
export const DEFAULT_MODEL = "big-pickle";

/**
 * Resolve provider settings from `env` (defaults to `process.env`).
 * `AICOMMIT_*` variables win; `OPENCODE_API_KEY` remains as a legacy
 * fallback for the key only. Throws {@link ConfigError} when no key is set.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const baseURL = env.AICOMMIT_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const model = env.AICOMMIT_MODEL?.trim() || DEFAULT_MODEL;
  const apiKey = env.AICOMMIT_API_KEY?.trim() || env.OPENCODE_API_KEY?.trim();

  if (!apiKey) {
    throw new ConfigError("AICOMMIT_API_KEY is not set", {
      suggestions: [
        "Set it with: export AICOMMIT_API_KEY=<your-key>",
        "OPENCODE_API_KEY is honored as a fallback",
      ],
    });
  }

  return { baseURL, apiKey, model };
}
