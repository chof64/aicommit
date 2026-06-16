import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirm, sanitizeCommitMessage } from "../src/cli.js";
import { AbortError, ConfigError, ValidationError } from "../src/errors.js";

/**
 * Fake readline interface: lets tests push line events without a real TTY.
 * Mirrors the subset of the real `Interface` that `confirm()` uses.
 */
class FakeReadline extends EventEmitter {
  closed = false;
  close() {
    this.closed = true;
  }
}

// Module-level mock: replaces node:readline so confirm() uses our fake interface.
// Vitest hoists vi.mock above imports.
vi.mock("node:readline", async () => {
  const actual = await vi.importActual<typeof import("node:readline")>("node:readline");
  return {
    ...actual,
    createInterface: vi.fn(),
  };
});

describe("sanitizeCommitMessage", () => {
  it("strips newlines and trims surrounding whitespace", () => {
    expect(sanitizeCommitMessage("  feat: thing\n\nwith detail  \n")).toBe(
      "feat: thing with detail",
    );
  });

  it("collapses runs of CR/LF into a single space", () => {
    expect(sanitizeCommitMessage("a\r\n\r\nb")).toBe("a b");
  });

  it("throws ValidationError on empty input", () => {
    expect(() => sanitizeCommitMessage("   \n\n  ")).toThrow(ValidationError);
  });

  it("throws ValidationError on input starting with '-'", () => {
    try {
      sanitizeCommitMessage("--upload-pack=evil");
      throw new Error("expected ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toMatch(/starts with '-'/);
    }
  });
});

describe("confirm", () => {
  let originalIsTTY: boolean | undefined;
  let fakeRl: FakeReadline;
  let createInterfaceMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    originalIsTTY = process.stdin.isTTY;
    fakeRl = new FakeReadline();
    const readline = await import("node:readline");
    createInterfaceMock = readline.createInterface as unknown as ReturnType<typeof vi.fn>;
    createInterfaceMock.mockReset();
    createInterfaceMock.mockReturnValue(fakeRl as never);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
    vi.restoreAllMocks();
  });

  it("rejects with ConfigError in a non-TTY environment", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    await expect(confirm("feat: thing")).rejects.toBeInstanceOf(ConfigError);
    expect(createInterfaceMock).not.toHaveBeenCalled();
  });

  it("resolves when the user types Y (default-yes)", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const promise = confirm("feat: thing");
    // Defer emission so confirm() finishes wiring up rl.once('line') first.
    setImmediate(() => fakeRl.emit("line", "Y"));
    await expect(promise).resolves.toBeUndefined();
    expect(fakeRl.closed).toBe(true);
  });

  it("resolves on empty input (default-yes branch)", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const promise = confirm("feat: thing");
    setImmediate(() => fakeRl.emit("line", ""));
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects with AbortError when the user types n", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const promise = confirm("feat: thing");
    setImmediate(() => fakeRl.emit("line", "n"));
    await expect(promise).rejects.toBeInstanceOf(AbortError);
    expect(fakeRl.closed).toBe(true);
  });

  it("treats 'N' (uppercase) the same as 'n' for abort", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const promise = confirm("feat: thing");
    setImmediate(() => fakeRl.emit("line", "N"));
    await expect(promise).rejects.toBeInstanceOf(AbortError);
  });
});

// `Readable` is imported only to anchor the type analysis; mark it used.
void Readable;
