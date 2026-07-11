import { execFileSync, spawn } from "node:child_process";
import { GitError } from "./errors.js";
import { logVerbose } from "./logger.js";

/** Read the staged diff. Rejects with GitError on failure or empty diff. */
export function getStagedDiff(): Promise<string> {
  logVerbose("Checking for staged changes...");

  return new Promise<string>((resolve, reject) => {
    const proc = spawn("git", ["diff", "--cached"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => {
      outChunks.push(c);
    });
    proc.stderr.on("data", (c: Buffer) => {
      errChunks.push(c);
    });

    proc.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        reject(new GitError("git is not installed or not on PATH", { cause: err }));
        return;
      }
      const stderr = Buffer.concat(errChunks).toString("utf-8");
      reject(new GitError(`git diff failed: ${stderr.trim() || String(err)}`, { cause: err }));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf-8");
        // Two ways "not a git repository" surfaces: literal stderr, or the
        // implicit no-index mode rejecting --cached (Apple/system git).
        const notAGitRepo =
          stderr.includes("not a git repository") ||
          (stderr.includes("unknown option") && stderr.includes("cached"));
        if (notAGitRepo) {
          logVerbose(`Detected "not a git repository" via stderr`);
          reject(new GitError("Not a git repository — run from inside a repo"));
          return;
        }
        reject(
          new GitError(
            `git diff failed: ${stderr.trim() || `git exited with code ${code ?? "unknown"}`}`,
          ),
        );
        return;
      }
      const diff = Buffer.concat(outChunks).toString("utf-8").trim();
      logVerbose(`Staged diff: ${diff.length} bytes`);
      if (!diff) {
        reject(new GitError("No staged files", { suggestions: ["Run 'git add <files>' first"] }));
        return;
      }
      resolve(diff);
    });
  });
}

/** Run `git commit -m <message>`. Throws GitError on failure. */
export function executeCommit(message: string): void {
  try {
    execFileSync("git", ["commit", "-m", message], { stdio: "inherit" });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    const detail = stderr ? stderr.toString().trim() : String(err);
    throw new GitError(`git commit failed: ${detail}`, { cause: err });
  }
}
