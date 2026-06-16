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

  it("reset() suppresses subsequent writes even after a previous verbose write", () => {
    setVerbose(true);
    const firstSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    logVerbose("before reset");
    const callsAfterFirstWrite = firstSpy.mock.calls.length;
    expect(callsAfterFirstWrite).toBeGreaterThan(0);

    reset();

    // New spy is aliased to the same underlying mock. Clear the call log so
    // we only count writes that happened *after* reset.
    firstSpy.mockClear();
    logVerbose("after reset");
    expect(firstSpy).not.toHaveBeenCalled();
  });
});
