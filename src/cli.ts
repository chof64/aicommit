import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { Command } from "commander";
import { buildMessages, callWithRetry, parseCommitMessage } from "./api.js";
import { AbortError, AicommitError, ConfigError, formatError, ValidationError } from "./errors.js";
import { executeCommit, getStagedDiff } from "./git.js";
import { getVerbose, log, logError, logVerbose, reset, setVerbose } from "./logger.js";

/** Parsed CLI options (subset of commander's parsed result). */
export interface CliOptions {
  dryRun?: boolean;
  verbose?: boolean;
}

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

/** Read a required environment variable. Throws ConfigError on miss. */
function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ConfigError(`${name} is not set`, {
      suggestions: [`Set it with: export ${name}=<your-key>`],
    });
  }
  return value;
}

/** Strip control characters and reject dangerous leading dashes. */
function sanitizeCommitMessage(raw: string): string {
  const collapsed = raw.replace(/[\r\n]+/g, " ").trim();
  if (!collapsed) {
    throw new ValidationError("Commit message is empty after sanitization", {
      suggestions: ["The model returned an empty message — try again"],
    });
  }
  if (collapsed.startsWith("-")) {
    throw new ValidationError(
      "Commit message starts with '-', which would be parsed as a git flag",
      {
        suggestions: ["The model returned a malformed commit message — try again"],
      },
    );
  }
  return collapsed;
}

/**
 * Ask the user to confirm the proposed commit message. Default is yes;
 * only the literal `n` (case-insensitive) aborts. Throws ConfigError in
 * non-TTY environments (use a future --yes flag for those).
 */
function confirm(message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY !== true) {
      reject(
        new ConfigError("Non-interactive shell — cannot prompt for confirmation", {
          suggestions: [
            "Run interactively in a terminal",
            "See issue #21 for the planned --yes flag",
          ],
        }),
      );
      return;
    }

    process.stdout.write(`\n  ${message}\n\nProceed with commit? [Y/n] `);

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const cleanup = () => {
      rl.close();
    };

    rl.once("line", (line) => {
      cleanup();
      if (line.trim().toLowerCase() === "n") {
        reject(new AbortError());
        return;
      }
      resolve();
    });
  });
}

/** Build and run the commander program. */
export function run(): void {
  reset();

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
      const apiKey = getEnv("OPENCODE_API_KEY");

      const messages = buildMessages(hintPrompt, diff);
      const response = await callWithRetry(messages, apiKey);
      const message = sanitizeCommitMessage(parseCommitMessage(response));

      if (options.dryRun) {
        log("Dry run complete. No changes were committed.");
        return;
      }

      await confirm(message);
      log("Committing...");
      executeCommit(message);
      log("Done.");
    });

  program.parseAsync(process.argv).catch((err) => {
    logError(formatError(err, { verbose: getVerbose() }));
    const exitCode = err instanceof AicommitError ? err.exitCode : 1;
    process.exit(exitCode);
  });
}
