# Antigravity Critical Instructions - OOS Project

Always follow these rules when making changes to the OOS codebase.

## 1. Zero-Warning Build
After any non-trivial change, run a full project build to ensure no TypeScript errors or warnings were introduced.
- Command: `pnpm build`
- All packages (`shared`, `api`, `web`) must compile cleanly.

## 2. E2E Test Coverage
Mandatory E2E coverage for UI, API, or data flow changes.
- Add or update tests in `e2e/`.
- Ensure all tests pass before concluding a task.
- Run: `pnpm test:e2e`

## 3. Mandatory Docker Rebuild
Before concluding ANY task, you must rebuild the Docker stack to ensure the local environment is in sync with the latest code changes.
- Command: `docker compose -f docker-compose.host-db.yml up --build -d`

## 4. MeOS Compatibility
Maintain full bidirectional compatibility with MeOS databases. Refer to `.cursor/rules/e2e-and-docker.mdc` for specific technical details on control IDs, coordinates, and normalization.
