# Bugfix: Cloud Shell demo required pnpm and a source build

## Symptom

Running `bash scripts/demo.sh` from the Cloud Shell tutorial failed on a fresh
Cloud Shell checkout:

```text
scripts/demo.sh: line 32: pnpm: command not found
```

After installing pnpm, schema setup failed until all repository dependencies
were installed. The script then built Oxygen locally despite the project
publishing ready-to-run multi-architecture images.

Tracked by [issue #22](https://github.com/open-orienteering/oxygen/issues/22).

## Cause

The demo predated the GHCR release flow. It used the development Compose file,
ran Prisma from the host, and built the API and web images from source.

The first real-image smoke run also exposed a latent image defect: the
dependency stage did not have OpenSSL installed when Prisma selected its CLI
schema engine. It bundled the Debian OpenSSL 1.1 engine, while the runtime
detected OpenSSL 3 and attempted a network download before migrations. A
network-restricted deployment therefore could not start.

## Fix

`scripts/demo.sh` now:

1. selects `ghcr.io/open-orienteering/oxygen:edge` by default;
2. starts `docker-compose.release.yml`;
3. runs Prisma migrations from the selected image;
4. loads the showcase through the PostgreSQL container;
5. verifies both `/health` and the web application over HTTP.

The Docker dependency stage now installs OpenSSL before `pnpm install`, so the
matching migration engine is baked into the image and migrations do not depend
on `binaries.prisma.sh` at startup.

`OXYGEN_IMAGE` can select a release, immutable SHA tag, or another registry.
`OXYGEN_PORT` can change the host port.

The GHCR publish workflow also boots the exact image it just pushed under its
immutable `sha-<commit>` tag, loads the showcase through the same demo script,
checks HTTP health, and removes the isolated stack. This catches failures in
the image, migration command, Compose wiring, fixture loading, and static web
serving after publication.

## Tests

- `scripts/__tests__/release-compose.test.mjs` verifies that migrations and the
  app use the same selected image and that the demo has no host pnpm/build
  command.
- `.github/workflows/publish.yml` performs the real post-publish container
  smoke test.
