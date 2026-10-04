# Changelog

## 0.1.0 — 2026-10-04

First public version.

- `find`, `projects`: search secrets by key; print references, never values.
- `run`, `env run`, `env check`: inject secrets into a command from `--env`
  flags or a `.env.tpl` template; output is masked.
- `create`: save a secret from the clipboard or stdin; read back and checked.
- `import`: move secret keys from a `.env` file into Bitwarden and write a template.
- `read`: print or copy one value, for humans.
- `token`, `config`, `doctor`: setup, with the token in the macOS Keychain.
- Agent skill in `skill/2warden/SKILL.md`.
