# Release runbook — slice D (the new course editor behind its gate)

Slice D lands on `main` the same way slices A–C did
([release-slice-c.md](release-slice-c.md)): one PR from
`vector-map-pipeline`, a merge commit, a tag (`v0.5.0`), `deploy.sh`.
The new editor (Course, Layout and Field modes on the GL canvas) mounts
only for a `vector` event with a pinned document **and** the instance flag
`map.editor.vector = true` ([map-pipeline-switch.md](map-pipeline-switch.md)
§1, default `false`), so with the instance defaults every event keeps the
legacy editor. The point of deploying before the D-gate is the same as for
B and C: D-mobile (a real phone in the forest) and the D-gate's club dry
run need the released image on the club's instance.

## What this release carries

| Area | Change an operator can notice |
|---|---|
| Schema | six **additive** migrations: `20261031120000_course_structure` (`courses.structure`, site fields, version tokens), `20261101120000_course_objects`, `20261101130000_course_objects_source`, `20261102120000_control_description_source`, `20261103120000_auto_templates` (`map_templates.auto_key` / `is_extra` / `version`, `course_maps.section_index` / `class_id` / `props` / `version`, `classes.print_scale` / `sheet_template_id`; backfills every template's key, renames nothing, moves no sheet), `20261104120000_course_presence`. Older images ignore the new columns |
| Templates, **all events** | every template gets its key (`A4-portrait-10000`) shown as a badge on the Map templates and Maps pages; of templates sharing a key one is *auto*, the others *extra* (`course-layout.md` §5). A course without a map exported from the Maps page gets a first sheet on its key's auto template |
| Maintenance tab | a **Course structures** card (admin): fills `courses.structure` from the course columns and, for OCAD-imported courses, their imported gaps, cuts and objects (`course-layer.md` §6.4). Optional — the editor reads the columns when `structure` is NULL — but it carries imported leg gaps and course objects into the new editor |
| New editor (gated) | Course, Layout and Field modes (`course-editor.md`, `course-layout.md`); presence and live refresh between editors; version tokens refuse stale writes (`CONFLICT`); Export ▾; auto templates and class overrides; the event's auto-cuts toggle drawn and printed on `vector` events (D17) |
| Import | no importer or symbol-library change: no re-match |
| CI | `course-editor.spec.ts` on `map-vector` and `mobile`; E2E weights in `scripts/e2e-weights.mjs` |

Rollback: `./deploy.sh v0.4.1` (the migrations are additive; the old image
ignores the columns, and rows the new editor wrote keep their flat columns
current — `course.setStructure` writes both). Turn the gate off first if it
was turned on (below).

## 0. Preconditions

- `vector-map-pipeline` green on the merge commit (full AGENTS.md §6 run;
  the last PRs' CI).
- `gcloud auth login` done (`scripts/gcp/env.sh`).

## 1. Land D on `main`

```bash
git fetch origin
git checkout -b release/slice-d origin/vector-map-pipeline
gh pr create --base main --title "Slice D: the new course editor behind its gate (v0.5.0)" \
  --body "See docs/release-slice-d.md. Six additive migrations; the editor is gated by map.editor.vector (default false); rollback = v0.4.1."
```

Merge with a merge commit after green CI; afterwards merge `main` back
into `vector-map-pipeline` once.

## 2. Cut the release

```bash
git tag v0.5.0 <main merge commit>
git push origin v0.5.0          # release.yml retags sha-… as v0.5.0 and stable
```

## 3. Deploy

```bash
cd scripts/gcp
./deploy.sh v0.5.0              # migrate job (six migrations) then the service
```

Check: an event page shows the map as before; the Courses page lists
courses with lengths unchanged; the Map templates page shows each
template's key badge.

## 4. Open the gate for testing

The gate is an `oxygen.settings` row (no UI; SQL through a one-off Cloud
Run job with the `oxygen-database-url` secret, as in
[release-slice-a.md](release-slice-a.md)):

```sql
INSERT INTO oxygen.settings (key, value) VALUES ('map.editor.vector', 'true')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

It reaches every instance within 30 s. It applies to every `vector` event
with a pinned document; `legacy` events are unaffected. To close it, set
`'false'`. The event to test on: switch it to the new map engine on its
event page, optionally run the Maintenance tab's **Course structures**
card, and open the course editor (a phone opens in Field mode).

## 5. D-mobile and the D-gate on the released instance

- **D-mobile** (`SLICES.md`): Field mode on a real phone at a control site.
- **D-gate**: one real event planned on the new editor end to end
  including print, and the rollback drill (the event flipped back to
  `legacy` shows the same courses in the old editor).

## 6. After the release

- Decision-log row: date, tag, gate state.
- `SLICES.md`: D-mobile / D-gate rows note the released tag.
