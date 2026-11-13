# Release runbook — slice F (editor phase 2) — v0.7.0

Slice F is the new course editor's second phase (`docs/research/vector-map-pipeline/SLICES.md`,
rows F1–F32; F26 deferred): leg styles and Bézier bends, corridors,
crossing and map-issue points, map exchanges, variations and loops with
materialised variants, setter maps, description sheets as a PDF, IOF XML
and Purple Pen with the course structure, and the map-anchored layout
objects consolidated into course objects (F12). It ships as one tag,
**v0.7.0**, on top of v0.6.1.

## 1. What changes for the operator

Three migrations, applied by `deploy.sh`'s migrate job before the service:

| Migration | Row | Kind | An older image |
|---|---|---|---|
| `20261108120000_course_variants` | F6 | additive: `courses.parent_course_id`, `variant_key` | never reads them; a materialised variant shows as an ordinary course |
| `20261108150000_course_maps_setter_kind` | F10 | CHECK constraints only: `course_maps.kind` takes `'setter'` | reads a setter sheet as an unknown kind (no overlay) |
| `20261109120000_map_anchored_objects_to_course_objects` | F12 | **data-rewriting**: every map-anchored sheet / template object becomes a `course_objects` row | draws the moved objects as course objects; its Layout mode no longer shows them on the sheet |

The F12 migration has a guard: an object of a live event that has no
course-object kind stops it before anything is written. Its operator
record — reasons, fixes, SQL — is `docs/migrations/2026-f12-map-anchored-objects.md`.

No importer version changed (`ocad-16`, `omap-9`): no re-match is needed.
No environment variable changes.

## 2. Preflight

With the v0.7.0 image published (`release.yml` after the tag) and v0.6.1
still serving:

```bash
cd scripts/gcp
./db-job.sh jobs/f12-survey.js --tag v0.7.0
```

It must print **`dry_run OK`**. On `dry_run REFUSED`, fix what it lists
(`docs/migrations/2026-f12-map-anchored-objects.md` §1) on v0.6.1 and
survey again.

## 3. Backup, deploy

```bash
source scripts/gcp/env.sh
gcloud sql backups create --instance="$SQL_INSTANCE" --project="$PROJECT_ID" \
  --description="before v0.7.0 (F12)"
gcloud sql backups list --instance="$SQL_INSTANCE" --project="$PROJECT_ID" --limit=1
cd scripts/gcp && ./deploy.sh v0.7.0
```

## 4. Rollback

The two additive migrations need nothing. F12 rewrites data, so the clean
rollback is the §3 backup: `gcloud sql backups restore <BACKUP_ID>
--restore-instance="$SQL_INSTANCE" --project="$PROJECT_ID"`, then
`./deploy.sh v0.6.1`. Without a restore, v0.6.1 still runs on the
migrated database (see the table in §1).

## 5. F-gate on production

The user's check (`SLICES.md` row F-gate): one real forked class (a relay
or a butterfly) planned in the editor; its variants and the
all-variations page printed with `copies=runners`; pre-set variants on the
start list (F6b); a runner who ran another variant MP on the kiosk and
accepted at the desk with one click (F6c); a map-exchange course printed
as two parts; the IOF export opened in Purple Pen or Condes; setter maps
and description sheets printed for one event.

### Club production, 2026-11-13

v0.7.0 (`main` `2dd412da`, PR #174). The first F12 survey refused: one
dashed map-anchored path in the template of `261013_Raven` was stroked
`#fb09e7`, not purple (`coloured_stroke`). On the user's choice it was
recoloured `#a626ff` on v0.6.1 with a one-off `db-job.sh` script (the
object by id, inside a transaction that checked the old colour); the
survey then printed `dry_run OK` (1 object moves, 0 removed). On-demand
backup `1794588953793` ("before v0.7.0 (F12)"); `./deploy.sh v0.7.0`
applied the three migrations and serves revision `oxygen-00054-26b`, with
no errors in its logs. The F-gate (§5) is the user's.
