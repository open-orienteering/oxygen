---
name: build
description: Rebuild the Docker stack so the production image stays in sync with code changes. Use when the user says "build", "rebuild", "deploy", or wants to update the running Docker containers without running E2E tests.
---

# Build (Docker Rebuild)

Rebuild the Oxygen Docker stack. This is the same final step as the full verify flow, but skips E2E tests.

## Steps

1. **Rebuild and restart the Docker stack:**

```bash
docker compose -f docker-compose.host-db.yml up --build -d
```

2. **Verify containers are running:**

```bash
docker compose -f docker-compose.host-db.yml ps
```

Both `oxygen-api` and `oxygen-web` should show status `Up` / `running`.

3. **If a container is not running**, check its logs:

```bash
docker compose -f docker-compose.host-db.yml logs --tail 30 <service>
```

Fix the issue and re-run step 1.
