# Release runbook — the shared steps

Every release to the club's instance follows these steps. A release's own
note (`slice-<letter>.md`, listed in [README.md](README.md#release-runbooks))
holds only what is particular to it: what it carries, its migrations and
what an older image does with them, importer or job version changes, the
re-match, its rollback limits, its gates, and the record of what happened
on production. The tag and image mechanics are in
[README.md](README.md) ("Tags", "Cut a release").

Everything that talks to GCP needs `gcloud auth login` on the operator's
machine and `scripts/gcp/env.sh` (gitignored; `env.sh.example` shows the
shape).

## 0. Preconditions

- `main` green on its last merge commit: CI, plus the AGENTS.md §6 run.
- The release note written: what the release carries, a migrations table
  with the column "An older image" (what the previous release does on the
  migrated database), importer, print-job and environment changes, the
  rollback, the gates.
- `gcloud auth login` done; `source scripts/gcp/env.sh` works.

## 1. Land on `main`

```bash
git fetch origin
git checkout -b release/<name> origin/main
pnpm release:version <x.y.z>     # only the four package.json "version" lines
git commit -am "Release <x.y.z>"
```

Open the release PR into `main` with the release note and the version
bump, and merge it with a merge commit after green CI. (Until 2026-11-21
releases came from the integration branch `vector-map-pipeline`, which
then took `main` back once; that branch is retired.)

## 2. Cut the release

Tag the `main` merge commit once its publish job is green:

```bash
git checkout main && git pull
git tag v<x.y.z>
git push origin v<x.y.z>         # release.yml retags sha-… as v<x.y.z>, stable, latest
```

Cloud sessions cannot push tags (the proxy refuses `refs/tags`); the tag is
pushed from the maintainer's own machine.

## 3. Backup, deploy

```bash
source scripts/gcp/env.sh
gcloud sql backups create --instance="$SQL_INSTANCE" --project="$PROJECT_ID" \
  --description="before v<x.y.z>"
gcloud sql backups list --instance="$SQL_INSTANCE" --project="$PROJECT_ID" --limit=1
cd scripts/gcp && ./deploy.sh v<x.y.z>   # migrate job, then the service
```

Note the backup id and the new revision in the release note's record.

## 4. Re-match (when the importer or library version changed)

```bash
cd scripts/gcp
./backfill.sh --tag v<x.y.z> --rematch --dry-run   # lists the stale pins
./backfill.sh --tag v<x.y.z> --rematch
```

Record the count re-matched and failed.

## 5. Rollback

- **Whole release**: `./deploy.sh v<previous>`. This works without a restore
  only when every migration is additive or the previous image reads its
  result the same way (the release note's migrations table says so per
  migration). Pins re-matched by the new release stay until
  `./backfill.sh --tag v<previous> --rematch`.
- **Clean state**: restore the §3 backup:
  `gcloud sql backups restore <BACKUP_ID> --restore-instance="$SQL_INSTANCE" --project="$PROJECT_ID"`.
- The release note lists any per-feature rollback (a switch or setting)
  and what the previous image ignores.

## 6. Gates and the record

Run the release note's gates on production with the user. Write the
outcome (revision, backup id, re-match counts, gate results) into the
release note, and update the gate rows in
`docs/research/vector-map-pipeline/SLICES.md`.
