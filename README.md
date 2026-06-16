# @chof64/aicommit

[![CI](https://github.com/chof64/aicommit/actions/workflows/ci.yml/badge.svg)](https://github.com/chof64/aicommit/actions/workflows/ci.yml)

AI-powered commit message generator. Reads your staged `git diff`, sends it
to the [opencode.ai zen](https://opencode.ai) chat completions API, and
writes a conventional-commit message after a quick confirmation prompt.

## Requirements

- Node.js **20+** (uses native `fetch`)
- `git` on `PATH`
- An [opencode.ai](https://opencode.ai) API key exposed as `OPENCODE_API_KEY`

## Install

```sh
npm i -g @chof64/aicommit
```

## Configure

Export your opencode.ai API key in your shell rc:

```sh
export OPENCODE_API_KEY=<your-key>
```

## Usage

Stage your changes as usual, then run `aicommit`:

```sh
git add .
aicommit
```

Add a hint to steer the message — useful for non-obvious diffs:

```sh
git add src/auth.ts
aicommit fix race in token refresh
```

Flags:

| Flag              | Description                                              |
| ----------------- | -------------------------------------------------------- |
| `--dry-run`       | Print the generated message, do not commit.              |
| `-v` / `--verbose`| Echo verbose progress to stderr (network, retries).     |
| `-V` / `--version`| Print the version and exit.                              |
| `-h` / `--help`   | Print the help text and exit.                            |

You will always be asked to confirm before `git commit` runs. Press `n` (or
`N`) to abort; anything else (including just hitting Enter) confirms.

## How it works

1. Runs `git diff --cached` and aborts if nothing is staged.
2. Sends the diff (plus any hint) to
   `https://opencode.ai/zen/v1/chat/completions` with model `big-pickle`.
3. Asks the LLM for a single conventional-commit message
   (`<type>: <description>`).
4. Shows you the result, waits for `Y/n`, then runs `git commit -m`.

The full prompt sent to the model is in
[`src/config.ts`](./src/config.ts) — see `SYSTEM_PROMPT` and `USER_PROMPT_TAIL`.

## About

aicommit was created as a personal script to use AI in writing commit
messages. It was a simple tool, and a way for me to learn scripting. It
started as a Python script (with a shebang) on my Mac, but I found good
use for it, so I migrated it to TypeScript and published it to npm.

It may not be as feature rich as other similar tools — still new, and
under development — but it's the first project of mine on npm, and
the first with (planned) CI/CD workflows that automate development,
testing and deployment.

## What's next

I'm planning to add a few features as time goes on:

- **Customizable commit types** — including support for the Angular
  convention
- **Multiple AI models** — flexibility in which model to use, with OpenAI
  API compatibility
- **Optimizations** — to the current version and the prompt
- **Tests** — coverage for the core flow

## License

[MIT](./LICENSE)
