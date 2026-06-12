import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeCommit, getStagedDiff } from "../src/git.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);

describe("getStagedDiff", () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs `git diff --cached` and returns the trimmed output", () => {
    mockedExecFileSync.mockReturnValue("  diff --git a/foo b/foo\n+hi\n  ");
    const out = getStagedDiff();
    expect(out).toBe("diff --git a/foo b/foo\n+hi");
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["diff", "--cached"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  it("exits with a helpful message when the diff is empty", () => {
    mockedExecFileSync.mockReturnValue("   \n");
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(() => getStagedDiff()).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr.mock.calls.some((call) => String(call[0]).includes("No staged files"))).toBe(
      true,
    );

    exit.mockRestore();
    stderr.mockRestore();
  });
});

describe("executeCommit", () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls `git commit -m` with the message and inherits stdio", () => {
    mockedExecFileSync.mockReturnValue("");
    executeCommit("feat: thing");
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["commit", "-m", "feat: thing"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("exits with git's stderr when the commit fails", () => {
    const fakeErr = Object.assign(new Error("git failed"), {
      stderr: Buffer.from("nothing to commit"),
    });
    mockedExecFileSync.mockImplementation(() => {
      throw fakeErr;
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(() => executeCommit("feat: thing")).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr.mock.calls.some((call) => String(call[0]).includes("nothing to commit"))).toBe(
      true,
    );

    exit.mockRestore();
    stderr.mockRestore();
  });
});
