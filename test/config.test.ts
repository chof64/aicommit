import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults to the opencode zen endpoint and big-pickle model", () => {
    expect(loadConfig({})).toEqual({
      baseURL: DEFAULT_BASE_URL,
      apiKey: undefined,
      model: DEFAULT_MODEL,
    });
    expect(DEFAULT_BASE_URL).toBe("https://opencode.ai/zen/v1");
    expect(DEFAULT_MODEL).toBe("big-pickle");
  });

  it("works with no key at all (keyless mode)", () => {
    expect(loadConfig({}).apiKey).toBeUndefined();
    expect(() => loadConfig({})).not.toThrow();
  });

  it("prefers AICOMMIT_* overrides over defaults", () => {
    const config = loadConfig({
      AICOMMIT_BASE_URL: "https://api.example.com/v1",
      AICOMMIT_API_KEY: "override-key",
      AICOMMIT_MODEL: "gpt-4o-mini",
    });
    expect(config.baseURL).toBe("https://api.example.com/v1");
    expect(config.apiKey).toBe("override-key");
    expect(config.model).toBe("gpt-4o-mini");
  });

  it("falls back to OPENCODE_API_KEY when AICOMMIT_API_KEY is unset", () => {
    expect(loadConfig({ OPENCODE_API_KEY: "legacy" }).apiKey).toBe("legacy");
  });

  it("prefers AICOMMIT_API_KEY over the OPENCODE_API_KEY fallback", () => {
    expect(loadConfig({ AICOMMIT_API_KEY: "new", OPENCODE_API_KEY: "old" }).apiKey).toBe("new");
  });

  it("treats an empty or blank AICOMMIT_API_KEY as unset", () => {
    expect(loadConfig({ AICOMMIT_API_KEY: "", OPENCODE_API_KEY: "legacy" }).apiKey).toBe("legacy");
    expect(loadConfig({ AICOMMIT_API_KEY: "   " }).apiKey).toBeUndefined();
  });

  it("falls back to defaults when baseURL/model overrides are blank", () => {
    const config = loadConfig({
      AICOMMIT_API_KEY: "k",
      AICOMMIT_BASE_URL: "   ",
      AICOMMIT_MODEL: "",
    });
    expect(config.baseURL).toBe(DEFAULT_BASE_URL);
    expect(config.model).toBe(DEFAULT_MODEL);
  });
});
