#!/usr/bin/env bash
# Apply pending Prisma migrations using the same image selection as deploy.sh
# (GHCR tag by default, or --from-source for an Artifact Registry build).
set -euo pipefail
cd "$(dirname "$0")"
exec ./deploy.sh --migrate-only "$@"
