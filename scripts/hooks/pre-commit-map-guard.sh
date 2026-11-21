#!/usr/bin/env bash
# Git pre-commit hook: refuse a commit that stages a map source (OCAD,
# OpenOrienteering Mapper) not on the public list (scripts/check-map-files.mjs).
# Enable once per clone (worktrees share it):
#   ln -s "$PWD/scripts/hooks/pre-commit-map-guard.sh" "$(git rev-parse --path-format=absolute --git-path hooks)/pre-commit"
# With a pre-commit hook already in place, call this script from it instead.
exec node "$(git rev-parse --show-toplevel)/scripts/check-map-files.mjs" --staged
