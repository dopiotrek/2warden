# 2warden

**Bitwarden Secrets Manager for coding agents.** Your agent finds, uses and saves
secrets by reference, and never needs to see the values.

```sh
2warden find stripe openai                          # → STRIPE_SECRET_KEY  bws://3f2a…  Agent
2warden env run .env.tpl -- pnpm dev                # start the app with the real values
2warden import apps/web/.env.local --prefix MYAPP_  # move an existing .env into Bitwarden
```

A sibling of [2password](https://github.com/kitlangton/2password), which does the
same for 1Password. 2warden is a small wrapper around Bitwarden's official `bws`
CLI, with no runtime dependencies.

> Not affiliated with or endorsed by Bitwarden, Inc.

---

## Why

Coding agents (Claude Code, Codex, Cursor and others) need API keys to run and
test your app. Today that usually means one of these:

- **A `.env` file with plain values.** The agent can `cat` it. Values end up in
  the chat transcript, in logs, and with the model provider.
- **You paste a key into the chat.** Same problem, plus it stays in your history.
- **You run every command yourself.** Safe, but then the agent cannot do its job.

The idea from 2password fixes this with one rule: **the agent works with
references, not values.** A reference like `bws://3f2a…` is safe to print, log
and commit. Only the one process that needs the secret gets the real value, at
the moment it starts. The agent sees `***`.

### Why Bitwarden Secrets Manager

Bitwarden has two products. 2warden uses **Secrets Manager**, not the personal
password vault, on purpose:

| | Personal vault (`bw` CLI) | Secrets Manager (`bws` CLI) |
|---|---|---|
| Unlock | Master password → a session key that opens **everything** | A **machine account** token |
| Scope | Your whole vault | Only the projects you grant |
| Touch ID in CLI | No | Not needed |

With Secrets Manager, you give the agent's machine account access to **one
project** (for example `Agent`). Even if something goes wrong, the token cannot
reach your bank login or your production keys in another project. The limit is
set by Bitwarden, not by the agent behaving well.

Secrets Manager also has a free plan and an EU region.

### How it works

```
  agent ──"2warden env run .env.tpl -- pnpm dev"──▶ 2warden
                                                    │ 1. reads token from macOS Keychain
                                                    │ 2. asks bws for the referenced secrets
                                                    ▼
                                              child process (pnpm dev)
                                              env: STRIPE_SECRET_KEY=sk_…   ← real value
                                                    │
  agent ◀── output with every value replaced by *** ┘
```

- The template (`.env.tpl`) holds only references. Commit it.
- The access token stays in the Keychain. The child process never gets it.
- New secrets come in through the clipboard or a pipe, never as a command argument.

---

## Setup

You need: **macOS or Linux**, **Node.js 22+**, **pnpm**, and a **Bitwarden account**.
It takes about 10 minutes, once.

### 1. Prepare Bitwarden (web app)

Secrets Manager lives inside a Bitwarden **organization**. A free one is fine.

1. Log in at [vault.bitwarden.com](https://vault.bitwarden.com), or
   [vault.bitwarden.eu](https://vault.bitwarden.eu) if your account is in the EU.
2. **No organization yet?** Click **+ New → Organization**, pick the **Free** plan,
   and tick **Subscribe to Secrets Manager** if you see it.
3. **Turn on Secrets Manager:** open the organization's **Admin Console →
   Billing → Subscription**, tick **Subscribe to Secrets Manager**, click **Submit**.
   Skip this if it is already on.
4. Open Secrets Manager with the **product switcher** (grid icon in the side menu).
5. **New → Project**, name it `Agent`, **Save**.
6. **New → Machine account**, name it e.g. `claude-agent`, **Save**.
7. Open the machine account → **Projects** tab → add `Agent` with
   **Can read, write**. With "Can read" only, `create` and `import` fail.
8. **Access tokens** tab → **Create access token** → name it after your computer,
   set an expiry date → **Create access token**. The token starts with `0.` and
   is shown **only once**. Leave the window open for step 4 below.

### 2. Install `bws` (Bitwarden's CLI)

There is no Homebrew formula. Download it from
[GitHub releases](https://github.com/bitwarden/sdk-sm/releases) and check the
checksum. Apple silicon:

```sh
V=2.1.0   # check the releases page for the newest bws-v* version
cd /tmp
curl -fLO https://github.com/bitwarden/sdk-sm/releases/download/bws-v$V/bws-aarch64-apple-darwin-$V.zip
curl -fLO https://github.com/bitwarden/sdk-sm/releases/download/bws-v$V/bws-sha256-checksums-$V.txt
grep aarch64-apple-darwin bws-sha256-checksums-$V.txt | shasum -a 256 -c -    # must say OK
unzip -o bws-aarch64-apple-darwin-$V.zip bws && mv bws /opt/homebrew/bin/ && bws --version
```

Intel Mac: use `x86_64-apple-darwin`. Linux: `x86_64-unknown-linux-gnu` or
`aarch64-unknown-linux-gnu`, and move `bws` to a folder on your `PATH`, e.g. `~/.local/bin`.

### 3. Install 2warden

```sh
git clone https://github.com/dopiotrek/2warden.git
cd 2warden
pnpm install && pnpm build && pnpm link --global
2warden --version
```

If `pnpm link --global` says there is no global bin directory, run `pnpm setup`,
open a new terminal, and try again.

### 4. Store the token

**Type** this command. Do not paste it: pasting replaces your clipboard.

```sh
2warden token set
```

It asks for the token with hidden input. Copy the token from the Bitwarden
window, paste it with Cmd+V (nothing appears), and press Enter.

- macOS: saved in your login **Keychain** (service `2warden`).
- Linux: saved in `~/.config/2warden/token` with mode `0600`.

Do **not** put `BWS_ACCESS_TOKEN` in your shell profile. Anything the agent runs
could read it there.

### 5. Settings and check

```sh
2warden config set project Agent
2warden config set server https://vault.bitwarden.eu   # EU accounts only
2warden doctor
```

`doctor` should end with `token works, sees 1 project(s): Agent`.

### 6. Teach your agent

Copy the skill so Claude Code knows the rules:

```sh
mkdir -p ~/.claude/skills && cp -R skill/2warden ~/.claude/skills/
```

For other agents, paste `skill/2warden/SKILL.md` into their instructions file
(`AGENTS.md`, `.cursorrules` and so on).

---

## Usage

### Find secrets

```sh
2warden find stripe openai       # several queries in one call
2warden find stripe --json       # [{ "key", "ref", "project" }]
2warden projects
```

`find` searches key names only. It never prints values or notes.

### Run a command with secrets

One or two variables:

```sh
2warden run --env OPENAI_API_KEY=bws://<id> -- pnpm dev
```

Many variables: keep a template next to your app. It is safe to commit.

```sh
# .env.tpl
OPENAI_API_KEY=bws://3f2a…
STRIPE_SECRET_KEY=bws://9c1d…
NODE_ENV=development          # plain values are passed through as they are
```

```sh
2warden env check .env.tpl              # every reference resolves?
2warden env run .env.tpl -- pnpm dev    # one bws call for all references
```

The command's output is filtered: every injected value becomes `***`, even when
it is split across two output chunks. The exit code is the command's own.
`--no-mask` turns the filter off, for interactive tools.

Real environment variables win over `.env` files in Vite, SvelteKit, Next.js and
most `dotenv` setups. So you can switch an app over while its `.env.local` still
exists, and remove the values from it once you trust the template.

### Move an existing `.env` file into Bitwarden

```sh
2warden import apps/web/.env.local --prefix MYAPP_ --dry-run    # shows what it would do
2warden import apps/web/.env.local --prefix MYAPP_              # does it
```

- It picks keys that look secret (`KEY`, `SECRET`, `TOKEN`, `PASSWORD`,
  `DATABASE_URL`, `DSN` …) and skips `PUBLIC_*`, `VITE_*`, `NEXT_PUBLIC_*`,
  `VERCEL*`, `TURBO_*` and empty values. Use `--only A,B,C` to choose yourself.
- Each one is saved as `MYAPP_<NAME>`. The prefix keeps the `DATABASE_URL` of
  two apps apart.
- Every value is read back and compared. A key that already exists is reused,
  not duplicated.
- It writes `.env.tpl` next to the file, with references only.

Think before you import **production** database URLs or live payment keys into
the agent's project. The agent never sees them, but it can **use** them, for
example by running a migration.

### Save a new secret

```sh
2warden create OPENAI_API_KEY --clipboard --note "dev key"    # value from the clipboard
some-generator | 2warden create WEBHOOK_SECRET --stdin         # value from a pipe
```

It prints the new reference. If the key already exists in the project, it stops
and shows the existing reference instead. It never retries a failed write.

### Monorepos with Turborepo

Turbo's default **strict env mode** passes a task only the variables listed in
`turbo.json`. Variables that 2warden injects are dropped on the way to your
`dev` task, and your app may then quietly fall back to `.env.local`. Either start
the app without Turbo:

```sh
2warden env run apps/web/.env.tpl -- pnpm --filter @my/app dev
```

or list the variables under `passThroughEnv` for the `dev` task in `turbo.json`.

---

## Commands

| Command | What it does | Shows a value? |
|---|---|---|
| `find <q…> [--project P] [--json]` | Search keys | No |
| `projects [--json]` | Projects the token can see | No |
| `run --env N=bws://… … [--no-mask] -- cmd` | Run `cmd` with secrets as env vars | No* |
| `env run <tpl> [--no-mask] -- cmd` | Same, from a template | No* |
| `env check <tpl>` | Check every reference resolves | No |
| `import <file> --prefix P [--only …] [--dry-run]` | `.env` → Bitwarden + template | No |
| `create KEY (--clipboard\|--stdin)` | Save one secret, read back, print ref | No |
| `read <ref> [--clipboard]` | Print or copy one value | **Yes** |
| `token set [--clipboard\|--stdin]` / `status` / `clear` | Manage the access token | No |
| `config set project\|server <v>` / `config show` | Defaults | No |
| `doctor` | Check the setup | No |

\* The command you run gets the value. Its output is masked.

---

## Security model

**What 2warden does:**

- Values never pass through the agent's command line, chat or files.
- `--env` refuses anything that is not a `bws://` reference.
- `find` searches key names only, so it cannot be used to probe values or notes.
- The command you `run` does not get `BWS_ACCESS_TOKEN`.
- Output of `run` and `env run` is masked.
- Error messages are scrubbed of the token and of the value being written.
- Every write is read back and compared. Writes are never retried, so a timeout
  cannot create a second copy.

**What it does not do. Please read this.**

- **It is not a sandbox.** The agent runs as your user. It could run
  `security find-generic-password -s 2warden -w` and read the token. The real
  limit is the machine account's access: grant it only the `Agent` project.
- **The command you run has the value.** It can send it anywhere. Masking only
  hides plain copies in its output, not base64 or other encodings. Values
  shorter than 6 characters are not masked.
- **`bws secret create` takes the value as an argument.** For the short life of
  that `bws` process, other processes of your user could see it in `ps`.
- **No approval prompt.** 1Password can ask for Touch ID per command. Bitwarden
  has no such hook for machine accounts. The token works until it expires or
  you revoke it, so give it an expiry date.

Report security problems as described in [SECURITY.md](SECURITY.md).

---

## Troubleshooting

| You see | Fix |
|---|---|
| `invalid_client` | The server does not know the token. EU account? `2warden config set server https://vault.bitwarden.eu` |
| `404 Not Found` on `create` or `import` | The machine account has only **Can read**. Set **Can read, write** on the project. |
| `does not look like a Bitwarden access token` | The clipboard held something else, often the command you just pasted. Type `2warden token set` and paste at the prompt. |
| `bws is not installed` | See step 2 of Setup. |
| The app starts, but uses old values | Turbo strict env mode, see *Monorepos with Turborepo*. |

---

## Development

```sh
pnpm install
pnpm verify      # type-check, build, and tests against a fake bws (no account needed)
```

Code map: `src/cli.ts` (commands), `src/bws.ts` (calls to `bws`),
`src/mask.ts` (output filter), `src/import.ts`, `src/token.ts` (Keychain),
`test/fake-bws.mjs` (stand-in for `bws` in tests).

Ideas for later: an `update` command, Bitwarden's SDK instead of the `bws`
binary so values never touch argv, and read-only access to the personal vault
through `bw` with Touch ID.

## Credits

Idea and command design from [2password](https://github.com/kitlangton/2password)
by Kit Langton. Built on Bitwarden's [`bws`](https://github.com/bitwarden/sdk-sm).

## License

[MIT](LICENSE)
