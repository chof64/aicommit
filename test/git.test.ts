import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitError } from "../src/errors.js";
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

  it("throws GitError with 'no staged files' suggestion when diff is empty", () => {
    mockedExecFileSync.mockReturnValue("   \n");
    try {
      getStagedDiff();
      throw new Error("expected GitError");
    } catch (err) {
      expect(err).toBeInstanceOf(GitError);
      expect((err as GitError).message).toMatch(/no staged files/i);
      expect((err as GitError).suggestions[0]).toMatch(/git add/);
    }
  });

  it("throws GitError('not a git repository') when git stderr matches", () => {
    const fakeErr = Object.assign(new Error("git failed"), {
      code: undefined,
      stderr: Buffer.from("fatal: not a git repository (or any of the parent directories): .git"),
    });
    mockedExecFileSync.mockImplementation(() => {
      throw fakeErr;
    });
    try {
      getStagedDiff();
      throw new Error("expected GitError");
    } catch (err) {
      expect(err).toBeInstanceOf(GitError);
      expect((err as GitError).message).toMatch(/not a git repository/i);
    }
  });

  it("throws GitError('git not installed') on ENOENT", () => {
    const fakeErr = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    mockedExecFileSync.mockImplementation(() => {
      throw fakeErr;
    });
    try {
      getStagedDiff();
      throw new Error("expected GitError");
    } catch (err) {
      expect(err).toBeInstanceOf(GitError);
      expect((err as GitError).message).toMatch(/not installed/i);
    }
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

  it("rethrows as GitError when the commit fails", () => {
    const fakeErr = Object.assign(new Error("git failed"), {
      stderr: Buffer.from("nothing to commit"),
    });
    mockedExecFileSync.mockImplementation(() => {
      throw fakeErr;
    });
    try {
      executeCommit("feat: thing");
      throw new Error("expected GitError");
    } catch (err) {
      expect(err).toBeInstanceOf(GitError);
      expect((err as GitError).message).toMatch(/git commit failed/);
      expect((err as GitError).message).toMatch(/nothing to commit/);
      expect((err as GitError).cause).toBe(fakeErr);
    }
  });
});
