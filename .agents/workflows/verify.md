---
description: Verify changes by building the project, running E2E tests, and rebuilding the Docker stack.
---

This workflow ensures that all changes maintain high quality and follow the project requirements.

1. Build the project and check for TypeScript/Build warnings.
// turbo
```bash
pnpm build
```

2. Run E2E tests to ensure no regressions.
// turbo
```bash
pnpm test:e2e
```

3. Rebuild the Docker stack to keep it in sync.
// turbo
```bash
docker compose -f docker-compose.host-db.yml up --build -d
```
