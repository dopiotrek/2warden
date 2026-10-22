#!/bin/bash
# Claude Code PreToolUse hook (Edit|Write|MultiEdit): block edits to protected files.
# Exit 2 = block; stderr goes to Claude as the reason.
in=$(cat)
f=$(jq -r '.tool_input.file_path // empty' <<<"$in")
[ -z "$f" ] && exit 0
name=$(basename "$f")

case "$name" in
  .env.example|.env.sample|.env.template) ;;   # templates are OK
  .env|.env.*)
    echo "Blocked: $f holds secrets. Tell the user which value to change; do not edit it." >&2; exit 2 ;;
  pnpm-lock.yaml|package-lock.json|yarn.lock|bun.lock|bun.lockb)
    echo "Blocked: $f is a lockfile. Run the package manager (pnpm install/add/remove) instead." >&2; exit 2 ;;
esac

if [[ "$f" == */migrations/*.sql && -e "$f" ]]; then
  echo "Blocked: $f is an existing migration that may already be applied. Never edit an applied migration. Change the Drizzle schema and generate a new migration with the repo's own command (usually 'pnpm db:generate'; see the repo's CLAUDE.md/AGENTS.md)." >&2
  exit 2
fi
exit 0
