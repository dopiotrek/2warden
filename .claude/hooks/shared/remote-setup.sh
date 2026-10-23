#!/bin/bash
# SessionStart: in a cloud session (fresh clone) prepare the repo once.
# Local sessions exit at once.
[ "$CLAUDE_CODE_REMOTE" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# 1. Placeholder env files: copy every .env.example to .env where none exists,
#    so svelte-kit sync and type checks see all keys. Values stay empty: no
#    secrets ever reach the cloud session.
find . -name .env.example -not -path '*/node_modules/*' | while read -r ex; do
  [ -e "$(dirname "$ex")/.env" ] || cp "$ex" "$(dirname "$ex")/.env"
done

# 2. Node version: warn when the cloud image runs an older major than .nvmrc.
want="$(cat .nvmrc .node-version 2>/dev/null | head -1 | tr -dc '0-9.' | cut -d. -f1)"
have="$(node -v 2>/dev/null | tr -dc '0-9.' | cut -d. -f1)"
if [ -n "$want" ] && [ -n "$have" ] && [ "$have" -lt "$want" ]; then
  echo "Cloud session: Node $have, but the repo wants Node $want. Add Node $want to the cloud environment setup script."
fi

# 3. Dependencies, once per clone.
[ -d node_modules ] && exit 0
command -v pnpm >/dev/null 2>&1 || corepack enable >/dev/null 2>&1 || npm i -g pnpm >/dev/null 2>&1
if pnpm install --frozen-lockfile >/tmp/pnpm-install.log 2>&1; then
  echo "Cloud session: dependencies installed. .env files hold empty placeholders and there is no database; say which verify steps could not run."
else
  echo "Cloud session: pnpm install failed, see /tmp/pnpm-install.log"
fi
exit 0
