import { execFileSync } from "node:child_process";
import { logError, logVerbose } from "./logger.js";

/** Read the staged diff. Exits with a helpful message if nothing is staged. */
export function getStagedDiff(): string {
  logVerbose("Checking for staged changes...");

  const diff = execFileSync("git", ["diff", "--cached"], { encoding: "utf-8" }).trim();
  logVerbose(`Staged diff: ${diff.length} bytes`);

  if (!diff) {
    logError("No staged files. Run 'git add <files>' first.");
    process.exit(1);
  }

  return diff;
}

/** Run `git commit -m <message>`. Exits with git's stderr on failure. */
export function executeCommit(message: string): void {
  process.stdout.write("→ Committing...\n");

  try {
    execFileSync("git", ["commit", "-m", message], { stdio: "inherit" });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    const detail = stderr ? stderr.toString().trim() : String(err);
    logError(`Error: git commit failed: ${detail}`);
    process.exit(1);
  }

  process.stdout.write("Done.\n");
}
