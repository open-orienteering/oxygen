#!/usr/bin/env bash
# Claude Code PreToolUse hook (matcher: Bash). Reads the tool call as JSON
# on stdin and blocks commands that use the fixed verification ports or
# shared test databases unless they run through scripts/with-verify-lock.sh.
# Exit 2 blocks the call and feeds stderr back to the model.
set -uo pipefail

cmd=$(jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$cmd" ] || exit 0

case "$cmd" in
  *with-verify-lock*) exit 0 ;;
esac

pattern='pnpm (run )?test:e2e|pnpm (run )?test:integration|playwright test|vitest\.integration|e2e-sharded\.mjs|docker compose -f docker-compose\.host-db\.yml'
if printf '%s' "$cmd" | grep -qE "$pattern"; then
  cat >&2 <<'EOF'
Blocked: this command uses fixed ports or shared test databases that other worktrees also use.
Run it through the lock instead:
  scripts/with-verify-lock.sh <the same command>
EOF
  exit 2
fi
exit 0
