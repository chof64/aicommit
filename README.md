# @chof64/aicommit

[![CI](https://github.com/chof64/aicommit/actions/workflows/ci.yml/badge.svg)](https://github.com/chof64/aicommit/actions/workflows/ci.yml)

AI-powered commit message generator. Reads your staged `git diff`, sends it
to any OpenAI-compatible chat completions endpoint (default:
[opencode.ai zen](https://opencode.ai)), and writes a conventional-commit
message after a quick confirmation prompt.

## Requirements

- Node.js **20+** (uses native `fetch`)
- `git` on `PATH`

An API key is **optional**. The default endpoint (opencode.ai zen) and model
(`big-pickle`) accept anonymous requests, so aicommit works out of the box
without any configuration. Set `AICOMMIT_API_KEY` only if your provider
requires one, or for access to paid models or higher rate limits.

## Install

```sh
npm i -g @chof64/aicommit
```

## Configure (optional)

All settings come from environment variables. Defaults target
[opencode.ai zen](https://opencode.ai); to authenticate, export your key:

```sh
export AICOMMIT_API_KEY=<your-key>
```

| Variable             | Default                       | Description                                        |
| -------------------- | ----------------------------- | -------------------------------------------------- |
| `AICOMMIT_API_KEY`   | — (optional)                  | API key sent as `Authorization: Bearer <key>`.     |
| `AICOMMIT_BASE_URL`  | `https://opencode.ai/zen/v1`  | OpenAI-compatible root URL of the endpoint.        |
| `AICOMMIT_MODEL`     | `big-pickle`                  | Model id served at the endpoint.                   |

`OPENCODE_API_KEY` is still honored as a fallback for `AICOMMIT_API_KEY`.

Any OpenAI-compatible provider works — for example, a local Ollama:

```sh
export AICOMMIT_BASE_URL=http://localhost:11434/v1
export AICOMMIT_MODEL=llama3.2
export AICOMMIT_API_KEY=ollama
```

Note: during the free-period of Big Pickle, requests may be used to improve
the model. Avoid sending diffs that contain personal or confidential data.

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
2. Sends the diff (plus any hint) to the configured OpenAI-compatible
   chat-completions endpoint (default: opencode.ai zen, `big-pickle`) via the
   [Vercel AI SDK](https://ai-sdk.dev) (`@ai-sdk/openai-compatible`).
3. Asks the LLM for a single conventional-commit message
   (`<type>: <description>`).
4. Shows you the result, waits for `Y/n`, then runs `git commit -m`.

The full prompt sent to the model is in
[`src/api.ts`](./src/api.ts) — see `SYSTEM_PROMPT` and `USER_PROMPT_TAIL`.

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
- **Optimizations** — to the current version and the prompt
- **Tests** — coverage for the core flow

## License

[MIT](./LICENSE)
