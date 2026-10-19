#!/usr/bin/env bash
# Serialise verification steps that use fixed ports or shared databases
# (integration tests, E2E, the Docker rebuild) across worktrees and
# sessions on this machine. Holds a machine-wide flock for the lifetime
# of the wrapped command; a second caller waits rather than colliding.
#
#   scripts/with-verify-lock.sh pnpm test:e2e
#   scripts/with-verify-lock.sh docker compose -f docker-compose.host-db.yml up --build -d
#
# The lock file lives outside the repository so every worktree sees the
# same one. Override with OXYGEN_VERIFY_LOCK.
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 64
fi

LOCK="${OXYGEN_VERIFY_LOCK:-${XDG_RUNTIME_DIR:-/tmp}/oxygen-verify.lock}"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "with-verify-lock: another verification holds $LOCK — waiting" >&2
  flock 9
fi
echo "with-verify-lock: acquired $LOCK" >&2
# exec keeps fd 9 open in the child, so the lock is held until it exits.
exec "$@"
