# Oxygen — Claude Code Instructions

## After Any Code Change

Always run unit tests after making changes:
```bash
pnpm test
```
All 208 tests across `shared`, `api`, and `web` must pass.

## After Completing a Feature or Fix

Always rebuild the Docker stack so the running instance reflects the latest code:
```bash
docker compose -f docker-compose.host-db.yml up --build -d
```
Do this automatically after tests and build pass — don't wait for the user to ask.

## Before Pushing Code / After Significant Changes

Run the full E2E suite before any `git push` or after any significant feature/fix:
```bash
pnpm test:e2e
```
All 97 E2E tests must pass. Fix failures before pushing — do not push a broken suite.

## Build Validation

After non-trivial changes, confirm the TypeScript build is clean:
```bash
pnpm build
```
All three packages (`shared`, `api`, `web`) must compile without errors.

## MeOS Compatibility

See `.cursor/rules/e2e-and-docker.mdc` for specific rules on schema compatibility, control IDs, coordinates, counter increments, and birth year normalization.

## Project Structure

- `packages/api/` — Fastify + tRPC backend
- `packages/web/` — React PWA frontend
- `packages/shared/` — Shared types and utilities
- `e2e/` — Playwright E2E tests
