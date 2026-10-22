#!/bin/bash
# SessionStart: in a cloud session (fresh clone) install dependencies once.
# Local sessions exit at once.
[ "$CLAUDE_CODE_REMOTE" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
[ -d node_modules ] && exit 0
command -v pnpm >/dev/null 2>&1 || corepack enable >/dev/null 2>&1 || npm i -g pnpm >/dev/null 2>&1
if pnpm install --frozen-lockfile >/tmp/pnpm-install.log 2>&1; then
  echo "Cloud session: dependencies installed. No .env and no local database here; say which verify steps could not run."
else
  echo "Cloud session: pnpm install failed, see /tmp/pnpm-install.log"
fi
exit 0
