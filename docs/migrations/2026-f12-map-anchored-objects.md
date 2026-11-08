# 2026 — F12: map-anchored layout objects become course objects

Row F12 of the vector map pipeline (`docs/research/vector-map-pipeline/SLICES.md`,
slice F). Until F12 a template or a sheet (`map_templates.objects`,
`course_maps.objects`) could hold layout objects anchored to the **map**
(`anchor: "map"`): white-outs, toner-saver rings, 709 areas, purple lines,
text and logos that move with the terrain. Course objects
(`course_objects`, slice D) are the stored, scoped kind of the same thing.
F12 moves the first into the second and retires the map anchor: the
course layer draws course objects only, Layout mode creates page-anchored
objects only. The specification is `docs/course-layer.md` §3.6 "Migration
(F12)"; this file is the operator's record.

## 1. What the migration changes

`packages/api/prisma/migrations/20261109120000_map_anchored_objects_to_course_objects/migration.sql`,
one transaction (Prisma), **data-rewriting**:

| Table | Change |
|---|---|
| `course_objects` | the CHECK on `source` takes `'layout'` besides `'import'`; one new row per map-anchored object that maps (kind, geometry, props, scope per `course-layer.md` §3.6), `source = 'layout'`, `version = 0`, `z` one below the event's lowest, `seq` from the event's counter |
| `map_templates.objects` | map-anchored objects removed; page-anchored objects kept in order (only rows that had one are written) |
| `course_maps.objects` | likewise |
| `club_map_templates.payload->'objects'` | map-anchored objects removed (they were never drawn: the import has always stripped them) |

Removed, not moved, and counted in the migration's NOTICE: objects that
draw nothing (no fill and no stroke, an empty text); a soft-deleted
event's objects that have no course-object kind.

Nothing else is touched: no column is dropped, no row of any other table
changes.

**The guard.** An object of a live event (`events.removed = false`) with
no course-object kind stops the migration before anything is written:

```
F12 guard: 3 map-anchored layout object(s) of live events have no course-object kind
(1 × coloured_stroke, 1 × solid_fill, 1 × stroked_whiteout); nothing was changed. …
DETAIL: event 12 map_templates seq 1 object 6f0c…: coloured_stroke
        event 12 course_maps seq 4 object 1a2b…: solid_fill
        …
```

| Reason | The object | Fix (one of) |
|---|---|---|
| `solid_fill` | a rectangle / path filled with a colour (`fillMode: "solid"`) | delete it; or make it a white-out |
| `coloured_line` | a line in a colour other than the template's purple | delete it; or recolour it purple (it becomes a 708 line, dashed a 707 route) |
| `coloured_stroke` | an unfilled rectangle / path stroked in a colour other than purple | as `coloured_line` |
| `stroked_whiteout` | a white-out or white-out outside with a border | drop the border (the white-out moves without it) |
| `degenerate_area` | a white-out / 709 / white-out outside path of fewer than three points | delete it |
| `text_too_large` | a text whose size divided by the sheet's enlargement (`mapScale / printScale`, below 1 when printing smaller than the map) exceeds a course object's 100 mm | make it smaller (or page-anchored) |
| `unknown_kind`, `unknown_fill`, `image_without_graphic`, `degenerate_line`, `malformed_text` | a malformed object | delete it |

Fix on the **current** release, before deploying: open the sheet or
template in Layout mode (the inspector still shows the anchor there) and
edit the object, or run the SQL below on the database. Then run the
preflight again.

```sql
-- Delete one object by id from a template (map_templates) or a sheet (course_maps).
UPDATE oxygen.course_maps SET objects = (
    SELECT coalesce(jsonb_agg(e ORDER BY i), '[]') FROM jsonb_array_elements(objects) WITH ORDINALITY a(e, i)
     WHERE e->>'id' <> '<object id>')
 WHERE event_id = <event id> AND seq = <row seq>;

-- Drop a white-out's border.
UPDATE oxygen.course_maps SET objects = (
    SELECT jsonb_agg(CASE WHEN e->>'id' = '<object id>' THEN e - 'stroke' - 'strokeWidthMm' - 'dash' ELSE e END ORDER BY i)
      FROM jsonb_array_elements(objects) WITH ORDINALITY a(e, i))
 WHERE event_id = <event id> AND seq = <row seq>;

-- Recolour a line or an outline purple.
UPDATE oxygen.course_maps SET objects = (
    SELECT jsonb_agg(CASE WHEN e->>'id' = '<object id>' THEN jsonb_set(e, '{stroke}', '"#a626ff"') ELSE e END ORDER BY i)
      FROM jsonb_array_elements(objects) WITH ORDINALITY a(e, i))
 WHERE event_id = <event id> AND seq = <row seq>;
```

The first two are the fix-ups the integration test runs before the
migration passes (`course-objects-migration.test.ts`).

## 2. Preflight on production

Before the release that carries F12, with the release's image built
(`release.yml`) and the current one still serving:

```bash
cd scripts/gcp
./db-job.sh jobs/f12-survey.js --tag <the release tag>
```

`jobs/f12-survey.js` is read-only. It prints:

- `map_anchored` — the map-anchored objects per table, live / removed
  event, kind, fill mode, stroke, dash: what will move.
- `map_anchored_by_event`, `club_payload_map_anchored` — where.
- `dry_run OK` (with the NOTICE: how many move, how many are removed) or
  `dry_run REFUSED` with the guard's message and one line per object:
  the migration file run inside a transaction that is always rolled back.
  **It must say OK** before deploying; fix what it lists (§1) and survey
  again. On an image without the F12 file it skips the dry run.

The same check by hand on a database you can reach (the dev database of
the main checkout, a restored copy):

```bash
( echo 'BEGIN;'; cat packages/api/prisma/migrations/20261109120000_map_anchored_objects_to_course_objects/migration.sql; echo 'ROLLBACK;' ) \
  | psql -v ON_ERROR_STOP=1 "$DATABASE_URL_WITHOUT_SCHEMA_PARAM"
```

and the counts alone:

```sql
SELECT 'map_templates' AS tbl, e.removed, x.obj->>'kind' AS kind, coalesce(x.obj->>'fillMode', 'none') AS fill,
       lower(x.obj->>'stroke') AS stroke, x.obj->>'dash' AS dash, count(*)
  FROM oxygen.map_templates t JOIN oxygen.events e ON e.id = t.event_id,
       jsonb_array_elements(CASE WHEN jsonb_typeof(t.objects) = 'array' THEN t.objects ELSE '[]' END) x(obj)
 WHERE x.obj->>'anchor' = 'map' GROUP BY 1, 2, 3, 4, 5, 6
UNION ALL
SELECT 'course_maps', e.removed, x.obj->>'kind', coalesce(x.obj->>'fillMode', 'none'), lower(x.obj->>'stroke'), x.obj->>'dash', count(*)
  FROM oxygen.course_maps m JOIN oxygen.events e ON e.id = m.event_id,
       jsonb_array_elements(CASE WHEN jsonb_typeof(m.objects) = 'array' THEN m.objects ELSE '[]' END) x(obj)
 WHERE x.obj->>'anchor' = 'map' GROUP BY 1, 2, 3, 4, 5, 6
 ORDER BY 1, 2, 3, 4;
```

## 3. Backup, deploy, rollback

Take an on-demand backup immediately before the deploy (production:
`gcloud sql backups create --instance="$SQL_INSTANCE" --project="$PROJECT_ID"
--description="before F12"`; the main checkout's dev database:
`pg_dump`). `deploy.sh` migrates before it deploys the service; a refused
guard exits the migrate job non-zero with nothing changed — fix, survey,
deploy again.

**Rollback** is the backup: restore it (`gcloud sql backups restore
<BACKUP_ID> --restore-instance=…`) and deploy the previous image. Without
a restore, the previous image also runs on the migrated data — its
schema reads every remaining layout object (page-anchored) and draws the
moved ones as course objects; only its Layout mode would no longer show
them on the sheet, and its writes could add new map-anchored objects that
a later run of the migration (idempotent) would move again.

## 4. Verified path

- `packages/api/src/__tests__/integration/course-objects-migration.test.ts`:
  a scratch database built to the migration before F12, seeded with every
  legacy shape (both tables, every sheet kind, a template's own purple, a
  print-scale override, an event without a map, a soft-deleted event,
  club payloads): the guard refuses and changes nothing; after the fix-ups
  every object maps as `course-layer.md` §3.6 says; a second run changes
  nothing.
- `course-print.test.ts` "F12": a migrated sheet prints its white-out and
  text from `course_objects`.
- `e2e/course-editor.spec.ts` "F12": a seeded legacy white-out, migrated
  on the E2E database, is listed in Course mode, white on the canvas and
  in the sheet's PDF.
- `scripts/gcp/jobs/f12-survey.js` run against the test database (dry run
  OK, nothing moved).
