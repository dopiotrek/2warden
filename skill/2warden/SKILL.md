---
name: 2warden
description: Use secrets (API keys, tokens, passwords) from Bitwarden Secrets Manager without seeing them. Use when a command needs a credential, when a .env file needs values, when the user gives you a new secret to store, or when you are tempted to ask the user to paste a key.
---

# 2warden

`2warden` gives you secrets by **reference** (`bws://<id>`). You pass references
around; the tool injects the real values into the one process that needs them.
You never need to see a value, and you must not try to.

## Rules

1. **Never ask the user to paste a secret into the chat.** Find it, or ask them
   to copy it to the clipboard and let `2warden create --clipboard` save it.
2. **Never put a secret value in a command, file, commit, log or message.**
   References (`bws://...`) are safe to write anywhere.
3. **Do not run `2warden read`** unless the user asks for that exact value. Use
   `read --clipboard` if they need it in hand.
4. **Do not print injected variables.** No `echo $KEY`, `env`, `printenv`, or
   debug logs of `process.env`. Output is masked, but do not rely on that.
5. **Never retry `create`.** If it fails or times out, run `2warden find <key>`
   to see whether it was saved before you do anything else.
6. If a key is missing, say so and stop. Do not invent a value or a placeholder.

## Find

```sh
2warden find openai stripe          # several queries, one call
2warden find openai --json          # [{ key, ref, project }]
```

## Run a command with secrets

One or two variables:

```sh
2warden run --env OPENAI_API_KEY=bws://<id> -- pnpm dev
```

Many variables: keep a template in the repo (safe to commit, it holds no values):

```sh
# .env.tpl
OPENAI_API_KEY=bws://<id>
STRIPE_SECRET_KEY=bws://<id>
NODE_ENV=development
```

```sh
2warden env check .env.tpl          # every reference resolves?
2warden env run .env.tpl -- pnpm dev
```

Do not write a real `.env` file with values. Use `env run` instead.

Output from `run` and `env run` is masked: values become `***`. The exit code is
the child's exit code. `--no-mask` turns masking off; only use it for
interactive tools when the user asks.

## Save a new secret

Ask the user to copy the value to their clipboard, then:

```sh
2warden create OPENAI_API_KEY --clipboard --project Agent --note "dev key for X"
```

It prints the new `bws://` reference. The value is read back and checked. If a
key with that name already exists, it stops and shows the existing reference:
use that one.

From a pipe (for example, a key another command generated):

```sh
some-command-that-prints-a-key | 2warden create NEW_KEY --stdin --project Agent
```

## When something fails

- `No access token` / `token does not work` → tell the user to run
  `2warden token set` themselves. Do not handle the token.
- `bws is not installed` → tell the user to install it (see the 2warden README). Do not install it yourself.
- Run `2warden doctor` and show the user its output.
