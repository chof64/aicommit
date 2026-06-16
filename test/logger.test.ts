import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getVerbose, logVerbose, reset, setVerbose } from "../src/logger.js";

describe("logger", () => {
  beforeEach(() => {
    reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("setVerbose(true) makes logVerbose write to stderr", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setVerbose(true);
    logVerbose("hello");
    expect(stderr).toHaveBeenCalled();
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/VERBOSE/);
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/hello/);
  });

  it("setVerbose(false) makes logVerbose a no-op", () => {
    setVerbose(false);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    logVerbose("hello");
    expect(stderr).not.toHaveBeenCalled();
  });

  it("reset() disables verbose and getVerbose() reflects the flag", () => {
    setVerbose(true);
    expect(getVerbose()).toBe(true);
    reset();
    expect(getVerbose()).toBe(false);
  });
});
