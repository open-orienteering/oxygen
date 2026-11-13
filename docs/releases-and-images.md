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

### The version

The git tag `vX.Y.Z` is the version of record. The release PR sets
`version` in the four `package.json` files (root, `packages/shared`,
`packages/api`, `packages/web`) with `pnpm release:version X.Y.Z`, and
`release.yml` refuses a tag whose commit carries another version
(`scripts/ghcr-ref.mjs check-release-version`). Between releases the
manifests keep the last release's version.

`release.yml` retags an image built before the tag existed, so the version
an image reports is decided when it is built, by `scripts/build-version.mjs`
(`publish.yml` checks out the full history with tags for it):

| The built commit | Version |
| --- | --- |
| The release commit: `package.json` ahead of the last `v*` tag | `package.json` (`0.8.0`) |
| The tagged commit | the tag (`0.7.0`) |
| Past the tag | `git describe --tags --match 'v*'` without the `v` (`0.7.0-3-gabc1234`) |
| No git, or no reachable `v*` tag (a shallow checkout) | `<package.json>-dev` (`0.7.0-dev`) |

"Ahead" is a numeric `X.Y.Z` comparison with the tag `git describe` names; a
`package.json` behind the tag (the history before v0.7.0 carried `0.1.0`)
follows `git describe`. Main commits merged after the release PR but before
its tag also report the bare `X.Y.Z`, so tag the release PR's merge commit
as soon as its publish is green.

The value travels as the Dockerfile's `BUILD_VERSION` build argument, which
is baked twice: as `OXYGEN_VERSION` in the API image, answered by
`/api/version` as `version`, and into the web bundle as its own fallback.
A build without the argument (local `docker build`, `docker compose
… --build`, `pnpm dev`) has `version: null` from the API and a bundle that
says `<package.json>-dev`.

### The footer

The event-selector footer shows one version and the build provenance:

```text
Oxygen v0.7.0 · Connected to PostgreSQL
Build: 2026-11-13 17:14 · Commit: 2dd412d
```

The version is the server's `/api/version` `version`, else the bundle's own
baked value. `Build:` is the bundle's build time and `Commit:` the
`OXYGEN_BUILD_ID` baked into the image. The image reference
(`OXYGEN_DEPLOY_REF`, recorded by `scripts/gcp/deploy.sh` or set on another
host) appears as `· Image: <ref>` between them only when it is not that
version's own tag (`vX.Y.Z` or `X.Y.Z`): `edge`, `stable`, `sha-…`,
`source-…`, or another release's tag:

```text
Oxygen v0.7.0-3-gabc1234 · Connected to PostgreSQL
Build: 2026-11-14 09:02 · Image: edge · Commit: abc1234
```

The Sync Status panel's build line follows the same `Image:` rule.

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
  Release. It fails when the tag differs from the tagged commit's
  `package.json` versions, or when that commit was never published from `main`.

## Cut a release

1. The release PR (the release branch into `main`) sets the version:

   ```bash
   pnpm release:version 1.2.3
   ```

   It changes only the `"version"` line of the four `package.json` files.
   Commit that with the release runbook (`docs/release-<name>.md`).

2. Merge it. `main` CI publishes `sha-<commit>` and `edge` from the merge
   commit; that image reports `1.2.3` (its `package.json` is ahead of the
   last tag).

3. Tag the merge commit as soon as its publish is green:

   ```bash
   git checkout main
   git pull
   git tag v1.2.3
   git push origin v1.2.3
   ```

   `release.yml` checks the tag against the commit's `package.json`, retags
   the image `v1.2.3`, `1.2.3`, `stable` and `latest`, and opens the GitHub
   Release. On a mismatch nothing is retagged: fix the version in a PR and
   tag that commit instead.

4. Deploy the tag (`scripts/gcp/deploy.sh v1.2.3`); the footer then reads
   `Oxygen v1.2.3` with no `Image:` part.

A release runbook records, besides its migrations and checks, the version
it sets (`pnpm release:version`) and the tag it deploys.

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
