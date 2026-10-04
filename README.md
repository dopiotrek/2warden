# 2warden

Bitwarden Secrets Manager for coding agents. The agent finds, uses and saves
secrets by reference (`bws://<id>`) and never needs to see the values.

Idea taken from [2password](https://github.com/kitlangton/2password) (same thing for 1Password).
This is a thin wrapper over Bitwarden's official `bws` CLI. No runtime dependencies.

```sh
2warden find openai stripe                                   # references, never values
2warden run --env OPENAI_API_KEY=bws://<id> -- pnpm dev      # inject, mask output
2warden env run .env.tpl -- pnpm dev                         # many at once, one bws call
2warden create OPENAI_API_KEY --clipboard --project Agent    # save from clipboard, read back
```

## Why Secrets Manager and not the personal vault

The `bw` CLI (personal vault) unlocks with the master password and gives a
session key that opens the **whole vault**. An agent that can see that key can
read everything. It also has no Touch ID unlock.

Secrets Manager has **machine accounts**. You give one machine account access
to one project, for example "Agent". Its token can only reach that project. So
the limit is set by Bitwarden, not by the agent behaving well.

## Setup (once)

1. In the Bitwarden web app, open **Secrets Manager** (it has a free plan) and
   create a project, e.g. `Agent`.
   EU account? Use `https://vault.bitwarden.eu`.
2. Create a **machine account**, give it **Can read, write** on `Agent` only,
   and create an **access token**. Copy it.
3. Install the tools:

   `bws` has no Homebrew formula. Get it from the
   [GitHub releases](https://github.com/bitwarden/sdk-sm/releases)
   (Apple silicon shown; check the latest version there):

   ```sh
   V=2.1.0
   cd /tmp
   curl -fLO https://github.com/bitwarden/sdk-sm/releases/download/bws-v$V/bws-aarch64-apple-darwin-$V.zip
   curl -fLO https://github.com/bitwarden/sdk-sm/releases/download/bws-v$V/bws-sha256-checksums-$V.txt
   grep aarch64-apple-darwin bws-sha256-checksums-$V.txt | shasum -a 256 -c -
   unzip -o bws-aarch64-apple-darwin-$V.zip bws && mv bws /opt/homebrew/bin/ && bws --version
   ```

   Then 2warden itself:

   ```sh
   cd ~/repos/apps/2warden && pnpm install && pnpm build && pnpm link --global
   ```

4. Store the token (from the clipboard, so it never sits in shell history) and set defaults:

   ```sh
   2warden token set --clipboard
   2warden config set project Agent
   2warden config set server https://vault.bitwarden.eu   # EU accounts only
   2warden doctor
   ```

5. Teach your agent: copy `skill/2warden/` to `~/.claude/skills/2warden/`.

Do **not** export `BWS_ACCESS_TOKEN` in your shell profile. 2warden reads it
from the Keychain and passes it only to `bws`.

## Commands

| Command | What it does | Shows a value? |
|---|---|---|
| `find <q...> [--json]` | Search keys (not notes) | No |
| `projects` | List projects the token sees | No |
| `run --env N=ref ... -- cmd` | Start `cmd` with secrets as env vars | No* |
| `env run <tpl> -- cmd` | Same, from a `NAME=bws://...` template | No* |
| `env check <tpl>` | Check every ref resolves | No |
| `create KEY --clipboard\|--stdin` | Save a new secret, read back, print ref | No |
| `read <ref> [--clipboard]` | Print or copy one value | **Yes** |
| `token set\|status\|clear` | Manage the access token | No |
| `config set project\|server` | Defaults | No |
| `doctor` | Check the setup | No |

\* The child process gets the value. Its stdout and stderr are masked (`***`)
by default. `--no-mask` turns that off.

## Safety model, plainly

What it does:

- Values never go through the agent's command line, chat or files. New values
  come from the clipboard or a pipe.
- `--env` refuses anything that is not a `bws://` reference.
- `find` searches keys only. Values and notes are never printed.
- The child of `run` does not get `BWS_ACCESS_TOKEN`.
- Output of `run` / `env run` is masked, also across chunk borders.
- Errors are scrubbed of the token and of the value being written.
- Every `create` is read back and compared. Writes are never retried.

What it does **not** do (be honest with yourself about these):

- **It is not a sandbox.** The agent runs as your user. It can run
  `security find-generic-password -s 2warden -w` and get the token. The real
  limit is the machine account's access: keep it to the `Agent` project.
- **The child can leak.** A command you `run` has the value and can send it
  anywhere. Masking only hides plain copies in its output, not base64 or
  other encodings. Values shorter than 6 characters are not masked.
- **`bws secret create` takes the value as an argument.** For the short life
  of that `bws` process, another process of your user could see it in `ps`.
- **No approval prompt.** 1Password asks for Touch ID per command. Bitwarden
  has no such hook for machine accounts. The token works until you revoke it.

## Later, maybe

- `update` for an existing secret (`bws secret edit`).
- Use Bitwarden's SDK instead of `bws` so values never touch argv.
- Optional read-only use of the personal vault through `bw` +
  [bitwarden-cli-bio](https://github.com/jeanregisser/bitwarden-cli-bio) (Touch ID).

## Development

```sh
pnpm verify    # type-check, build, 22 tests against a fake bws
```

MIT
