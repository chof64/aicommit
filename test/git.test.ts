import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitError } from "../src/errors.js";
import { executeCommit, getStagedDiff } from "../src/git.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedSpawn = vi.mocked(spawn);

/**
 * Fake `ChildProcess` returned by the mocked `spawn`. Mirrors the subset of
 * the real ChildProcess that `getStagedDiff` touches: a `Readable` for
 * stdout/stderr, an EventEmitter surface (`on`/`emit`/`once`), and `kill`.
 * Tests push data into the streams via `pushStdout` / `pushStderr`, then
 * signal completion via `closeWith(code)` or failure via `errorOut(err)`.
 */
class FakeChildProcess extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  pushStdout(chunk: string | Buffer): void {
    this.stdout.push(typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk);
  }

  pushStderr(chunk: string | Buffer): void {
    this.stderr.push(typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk);
  }

  closeWith(code: number | null): void {
    this.stdout.push(null);
    this.stderr.push(null);
    setImmediate(() => this.emit("close", code));
  }

  errorOut(err: Error): void {
    this.emit("error", err);
  }
}

describe("getStagedDiff", () => {
  let proc: FakeChildProcess;

  beforeEach(() => {
    proc = new FakeChildProcess();
    mockedSpawn.mockReset();
    mockedSpawn.mockImplementation(() => proc as unknown as ReturnType<typeof spawn>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs `git diff --cached` and returns the trimmed output", async () => {
    const promise = getStagedDiff();
    proc.pushStdout("  diff --git a/foo b/foo\n+hi\n  ");
    proc.closeWith(0);
    const out = await promise;
    expect(out).toBe("diff --git a/foo b/foo\n+hi");
    expect(mockedSpawn).toHaveBeenCalledWith(
      "git",
      ["diff", "--cached"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
  });

  it("rejects with GitError('no staged files') when diff is empty", async () => {
    const promise = getStagedDiff();
    proc.closeWith(0);
    await expect(promise).rejects.toMatchObject({
      message: expect.stringMatching(/no staged files/i),
      suggestions: [expect.stringMatching(/git add/)],
    });
  });

  it("rejects with GitError('not a git repository') when git stderr matches", async () => {
    const promise = getStagedDiff();
    proc.pushStderr("fatal: not a git repository (or any of the parent directories): .git");
    proc.closeWith(128);
    await expect(promise).rejects.toMatchObject({
      message: expect.stringMatching(/not a git repository/i),
    });
  });

  it("rejects with GitError('git not installed') on ENOENT", async () => {
    const fakeErr = Object.assign(new Error("spawn git ENOENT"), {
      code: "ENOENT",
    });
    const promise = getStagedDiff();
    proc.errorOut(fakeErr);
    await expect(promise).rejects.toMatchObject({
      message: expect.stringMatching(/not installed/i),
    });
  });

  it("handles large diffs (10MB+) without throwing ENOBUFS", async () => {
    const totalSize = 10 * 1024 * 1024;
    const promise = getStagedDiff();
    proc.pushStdout("x".repeat(totalSize));
    proc.closeWith(0);
    const out = await promise;
    expect(out.length).toBe(totalSize);
    expect(out).toBe("x".repeat(totalSize));
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
