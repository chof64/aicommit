import { execFileSync } from "node:child_process";
import { GitError } from "./errors.js";
import { logVerbose } from "./logger.js";

/** Read the staged diff. Throws GitError on failure or empty diff. */
export function getStagedDiff(): string {
  logVerbose("Checking for staged changes...");

  let raw: string;
  try {
    raw = execFileSync("git", ["diff", "--cached"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
    if (e.code === "ENOENT") {
      throw new GitError("git is not installed or not on PATH", { cause: err });
    }
    const stderr = e.stderr?.toString() ?? "";
    // Two ways "not a git repository" surfaces: literal stderr, or the
    // implicit no-index mode rejecting --cached (Apple/system git).
    const notAGitRepo =
      stderr.includes("not a git repository") ||
      (stderr.includes("unknown option") && stderr.includes("cached"));
    if (notAGitRepo) {
      throw new GitError("Not a git repository — run from inside a repo", { cause: err });
    }
    throw new GitError(`git diff failed: ${stderr.trim() || String(err)}`, { cause: err });
  }

  const diff = raw.trim();
  logVerbose(`Staged diff: ${diff.length} bytes`);

  if (!diff) {
    throw new GitError("No staged files", { suggestions: ["Run 'git add <files>' first"] });
  }

  return diff;
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
