# aicommit

AI-powered commit message generator. Reads your staged `git diff`, sends it
to the [opencode.ai zen](https://opencode.ai) chat completions API, and
writes a conventional-commit message after a quick confirmation prompt.

No dependencies — Python 3 standard library only.

## Requirements

- Python 3.6+
- `git` on `PATH`
- An [opencode.ai](https://opencode.ai) API key exposed as `OPENCODE_API_KEY`

## Install

Drop the script somewhere on your `PATH` and `chmod +x` it. For example:

```sh
curl -o ~/.local/bin/aicommit https://raw.githubusercontent.com/chof64/aicommit/main/aicommit
chmod +x ~/.local/bin/aicommit
```

Or clone and link:

```sh
git clone https://github.com/chof64/aicommit.git ~/Developer/aicommit
ln -s ~/Developer/aicommit/aicommit ~/.local/bin/aicommit
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
git add src/auth.py
aicommit fix race in token refresh
```

Other flags:

| Flag        | Description                                              |
| ----------- | -------------------------------------------------------- |
| `--dry-run` | Print the generated message, do not commit.              |
| `-v` / `--verbose` | Echo verbose progress to stderr (network, retries). |

You will always be asked to confirm before `git commit` runs.

## How it works

1. Runs `git diff --cached` and aborts if nothing is staged.
2. Sends the diff (plus any hint) to
   `https://opencode.ai/zen/v1/chat/completions` with model `big-pickle`.
3. Asks the LLM for a single conventional-commit message
   (`<type>: <description>`).
4. Shows you the result, waits for `Y/n`, then runs `git commit -m`.

The full prompt sent to the model is in [`aicommit`](./aicommit) — see
`build_messages` and the module-level `ENDPOINT` / `MODEL` constants.

## License

[MIT](./LICENSE)
