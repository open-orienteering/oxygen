# Releases and container images

Oxygen publishes a public multi-architecture image to GitHub Container
Registry. Self-hosters, Cloud Run, Fargate, and Kubernetes all pull the
same tags. GitHub Actions never deploys to a club GCP project.

Image: `ghcr.io/open-orienteering/oxygen` (`linux/amd64`, `linux/arm64`).
It is the Dockerfile `cloud` target: API plus the built web app, listening
on port 8080 (`WEB_DIST_DIR=/app/web-dist`).

## Tags

| Tag | When it moves | Meaning |
| --- | ------------- | ------- |
| `sha-<40-char-commit>` | Never | Immutable build of that `main` commit |
| `edge` | Every successful `main` CI + publish | Latest verified main |
| `vX.Y.Z` / `X.Y.Z` | Never | GitHub Release of that version |
| `stable` / `latest` | When a `vX.Y.Z` tag is pushed | Current release |

Ordinary pushes to `main` do **not** move `latest`.

Until the first GitHub Release exists, `stable` / `latest` are absent — use
`edge` or a `sha-…` tag.

The event-selector footer separates the deliberately manual application
version from build provenance:

```text
Oxygen v0.1.0 · Connected to PostgreSQL
Build: 2026-09-19 09:15 · Image: edge · Commit: abcdef0
```

The application version comes from the root `package.json` and changes only
when a release deliberately updates it. The image reference is recorded by
`scripts/gcp/deploy.sh` (or `OXYGEN_DEPLOY_REF` on another host), while the
commit is baked into the published image as `OXYGEN_BUILD_ID`.

## Make the GHCR package public (one-time)

The first publish creates an org package that defaults to private. In GitHub:
**org → Packages → oxygen → Package settings → Change visibility → Public**.

Or:

```bash
gh api --method PUT \
  -H "Accept: application/vnd.github+json" \
  /orgs/open-orienteering/packages/container/oxygen/visibility \
  -f visibility=public
```

Public images need no pull secret on Cloud Run, Fargate, or Compose.

## GitHub Actions

- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — lint, build, unit,
  integration, and E2E on pull requests and `main`.
- [`.github/workflows/publish.yml`](../.github/workflows/publish.yml) — after
  `main` CI succeeds, Buildx pushes `sha-<commit>` and `edge`. No GCP credentials.
- [`.github/workflows/release.yml`](../.github/workflows/release.yml) — a git tag
  `vX.Y.Z` **retags** the existing SHA image (no rebuild) and opens a GitHub
  Release. If that commit was never published from `main`, the workflow fails.

## Cut a release

The commit must already be on `main` (so `edge` / `sha-…` exist):

```bash
git checkout main
git pull
git tag v1.2.3
git push origin v1.2.3
```

## Self-host with Compose

```bash
docker compose -f docker-compose.release.yml up -d
# pin a version:
OXYGEN_IMAGE=ghcr.io/open-orienteering/oxygen:v1.2.3 \
  docker compose -f docker-compose.release.yml up -d
```

The app is at http://localhost:8080. Compose applies Prisma migrations
before the app starts. Update by changing `OXYGEN_IMAGE` (or using `stable`)
and running `up -d` again — the migrate service re-runs.

Source-building files (`docker-compose.yml`, `docker-compose.host-db.yml`,
`docker-compose.venue.yml`) stay development / venue workflows.

## Other hosts (Fargate, Cloud Run, k8s)

Point the runtime at `ghcr.io/open-orienteering/oxygen:<tag>`. No registry
credential is required while the package is public. Roll back by redeploying
an older `vX.Y.Z` or `sha-…` tag.

Club Cloud Run uses the local script in [`docs/deploy-gcp-cloud-run.md`](deploy-gcp-cloud-run.md),
not GitHub Actions.
