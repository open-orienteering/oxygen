# Bugfix: GitHub Actions Node 20 runtime warnings

## Symptom

Every GitHub Actions job printed:

```
Node.js 20 is deprecated. The following actions target Node.js 20 but are
being forced to run on Node.js 24: actions/github-script@v7,
pnpm/action-setup@v4.
```

The runners already default to Node 24; pinning older action majors just
triggers the deprecation warning and will fail once Node 20 is removed.

## Cause

JavaScript actions declare their runtime in `action.yml` (`runs.using`).
`pnpm/action-setup@v4` and `actions/github-script@v7` still say `node20`.
The same was true of `actions/upload-artifact@v4` and the Docker v3/v6
actions used by publish/release.

This is independent of `setup-node`'s `node-version: 20`, which is the
toolchain we install for Oxygen itself (pnpm 10 / Node 20).

## Fix

Bump the workflow pins to majors that declare `runs.using: node24`:

| Action | From | To |
|--------|------|----|
| `pnpm/action-setup` | v4 | v6 |
| `actions/github-script` | v7 | v8 |
| `actions/upload-artifact` | v4 | v6 |
| `docker/setup-qemu-action` | v3 | v4 |
| `docker/setup-buildx-action` | v3 | v4 |
| `docker/login-action` | v3 | v4 |
| `docker/build-push-action` | v6 | v7 |

Stay on `pnpm/action-setup` (not `pnpm/setup`): Oxygen is on pnpm 10, and
`pnpm/setup` is for pnpm 11+.

## Tests

- `scripts/__tests__/gha-node24-actions.test.mjs` fails if a workflow
  re-pins a known Node 20 action major.
