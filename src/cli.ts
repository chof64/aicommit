import { createRequire } from "node:module";
import { Command } from "commander";
import { buildMessages, callWithRetry, parseCommitMessage } from "./api.js";
import { executeCommit, getStagedDiff } from "./git.js";
import { log, logError, logVerbose, setVerbose } from "./logger.js";

/** Parsed CLI options (subset of commander's parsed result). */
export interface CliOptions {
  dryRun?: boolean;
  verbose?: boolean;
}

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

/**
 * Ask the user to confirm the proposed commit message. Default is yes;
 * only the literal `n` (case-insensitive) aborts.
 */
function confirm(message: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(`\n  ${message}\n\n`);
    process.stdout.write("Proceed with commit? [Y/n] ");

    const onData = (chunk: Buffer) => {
      const reply = chunk.toString().trim().toLowerCase();
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      if (reply === "n") {
        process.stdout.write("Aborted.\n");
        process.exit(0);
      }
      resolve();
    };

    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

/** Build and run the commander program. */
export function run(): void {
  const program = new Command();

  program
    .name("aicommit")
    .description("AI-powered commit message generator")
    .version(pkg.version)
    .option("--dry-run", "generate commit message without committing")
    .option("-v, --verbose", "enable verbose output to stderr")
    .argument("[hint...]", "optional hint/context for the commit message")
    .action(async (hintArgs: string[], opts: CliOptions) => {
      const options: CliOptions = { dryRun: opts.dryRun, verbose: opts.verbose };
      setVerbose(Boolean(options.verbose));

      const hint = hintArgs.join(" ");
      const hintPrompt = hint ? `Context/hint: ${hint} ` : "";

      logVerbose("Starting aicommit");
      if (options.dryRun) logVerbose("Dry-run mode enabled");

      log("Checking for staged changes...");
      const diff = getStagedDiff();

      log("Generating commit message...");
      const apiKey = process.env.OPENCODE_API_KEY;
      if (!apiKey) {
        logError("Error: OPENCODE_API_KEY environment variable not set");
        logError("Set it with: export OPENCODE_API_KEY=<your-key>");
        process.exit(1);
      }

      const messages = buildMessages(hintPrompt, diff);
      const response = await callWithRetry(messages, apiKey);
      const message = parseCommitMessage(response);

      await confirm(message);

      if (options.dryRun) {
        process.stdout.write("Dry run complete.\n");
        return;
      }
      executeCommit(message);
    });

  program.parseAsync(process.argv).catch((err) => {
    logError(`Error: ${err}`);
    process.exit(1);
  });
}
