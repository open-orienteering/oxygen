# Release runbook — slices I and J (colour layers, course graphics) — v0.9.0

> The shared steps (preconditions, landing on `main`, tag, backup, deploy, re-match, rollback) are in [runbook.md](runbook.md); this note keeps what was particular to this release and its record.

Slice I draws every map on the IOF colour layers
(`docs/research/vector-map-pipeline/SLICES.md` rows I1–I9):

- colour roles for every symbol use and the two-order harness (I1, I2);
- the layered colour stack, source order and deviations (I3, I4);
- the importer drawing on the IOF colour layers (I5, `ocad-19` / `omap-12`);
- the per-map colour order switch and the Colour layers panel (I6);
- per-deviation overrides (I7, `map_document_colour_settings`);
- the before / after compare view and its diff (I8a, I8b);
- roads and paved areas over the blue lines kept by default (I9,
  `ocad-20` / `omap-13`).

Slice J is course graphics on the print sheet (rows J1–J20, J17
deferred): graphic pixel sizes, door images attached to controls,
translucent corridor bands (J13), knockout images cut by the graphic's
traced outline (J15, J19), multi-select of course objects (J16), hidden
circle / number on an attached image (J18) and multi-file upload (J20).

Beside them: G30–G32 (the `T` tool splits GPS tracks and map lines at a
node; TCX import) and, from `main`, the SPORTident Reader BT over Web
Bluetooth with the reader hub (PR #104). All ship as one tag,
**v0.9.0**, on top of v0.8.0. The version is set by
`pnpm release:version 0.9.0`.

## 1. What changes for the operator

Six migrations. `deploy.sh`'s migrate job applies them before the
service starts:

| Migration | Row | Kind | An older image |
|---|---|---|---|
| `20261118120000_map_colour_settings` | I6 | new table `map_colour_settings`; `colour` column on `map_import_jobs` (default `{}`) | never reads the table; its jobs get `{}`, the defaults |
| `20261118190000_map_document_colour_settings` | I7 | new cache-like table `map_document_colour_settings` | never reads it |
| `20261119120000_graphics_pixel_size` | J2 | `width_px` / `height_px` on `graphics`, PNGs backfilled from their IHDR | ignores them |
| `20261119130000_course_objects_attach` | J10 | nullable `attach` on `course_objects` | ignores it: an attached object stays where it was last drawn |
| `20261119140000_corridor_white_opacity_reset` | J13 | **data**: every corridor `whiteOpacity` below 1 in `courses.structure` set to 1 | draws the band opaque, as before; the reset changes nothing it shows |
| `20261119150000_graphics_outline` | J19 | nullable `outline` on `graphics`, traced lazily | ignores it |

Only J13 rewrites data, and only a value that drew opaque until J13
(`course-layer.md` §6.4 "J13 reset"); old maps print as before. No
preflight survey is needed.

**Importer versions changed**: `ocad-18` → `ocad-20` and `omap-11` →
`omap-13`. Every map now draws on the IOF colour layers by default
(`map-symbols.md` §9.3), so every pinned map must be re-matched after the
deploy (§3).

**Print job version** 2 → 7 (J5–J19). A print job stored offline on a
device at an older version reads as not stored; the device stores it
again the next time Layout mode opens online, or with *Make maps
available offline*.

**Environment variables.** None new are required.

## 2. Backup, deploy

With the v0.9.0 image published (`release.yml` after the tag):

```bash
source scripts/gcp/env.sh
gcloud sql backups create --instance="$SQL_INSTANCE" --project="$PROJECT_ID" \
  --description="before v0.9.0 (slices I, J)"
gcloud sql backups list --instance="$SQL_INSTANCE" --project="$PROJECT_ID" --limit=1
cd scripts/gcp && ./deploy.sh v0.9.0
```

## 3. Re-match

```bash
cd scripts/gcp && ./backfill.sh --tag v0.9.0 --rematch --dry-run
./backfill.sh --tag v0.9.0 --rematch
```

The re-match moves each pin to the new importer versions, now drawn on
the IOF colour layers. Look at every club map's before / after picture
(the compare view, I8a / I8b) as part of the I-gate (§5). A map that
reads worse in the IOF order is switched to its own order in its Colour
layers panel, or given a per-deviation override, and re-imports with
that setting.

## 4. Rollback

**Per map**: switch the map to its own colour order (the Colour layers
panel). It re-imports in the mapper's table order, as v0.8.0 drew it.

**Whole release**: run `./deploy.sh v0.8.0`. The migrations are additive
apart from the J13 reset, which v0.8.0 draws the same way, so v0.8.0
runs on the migrated database (see the table in §1) and no restore is
needed. In that state, colour settings and attachments are kept but
ignored, and knockout and translucent graphics print as v0.8.0 printed
them. Maps re-matched under v0.9.0 keep their new pins until
`./backfill.sh --tag v0.8.0 --rematch` is run. If a clean state is
needed, restore the §2 backup with
`gcloud sql backups restore <BACKUP_ID> --restore-instance="$SQL_INSTANCE" --project="$PROJECT_ID"`.

## 5. Gates on production

**I-gate** (the user and the club; `SLICES.md` row I-gate):

- After the re-match, every club map's before / after picture looked at.
- A course on a map whose table is badly ordered (Testkarta): circles and
  legs over the areas, numbers on top.
- One map switched to its own order and back.
- One map printed.

**J-gate** (row J-gate):

- Two or three door PNGs in the club library; one placed on a control,
  attached, copied onto every control of a course.
- A control moved; its door follows.
- Frame opacity changed and Multiply tried.
- The sheet printed on the club printer: the middle shows the map at full
  strength, circles and numbers show, canvas and paper agree.
- A photo beside a control. A rotated, cropped logo on a template.
- An old event's `maps.pdf` byte-identical to before the slice.

**Reader BT** (PR #104): one Reader BT connected at the finish, a card
read, the link dropped and recovered on the next card.
