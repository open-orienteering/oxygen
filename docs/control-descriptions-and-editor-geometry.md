# Control Descriptions on the Control Row + Editor Geometry

Groundwork for the interactive course editor (Phase 1 of the
course-setting editor plan). Two related changes to the reference data
model, August 2026.

## 1. `controls.description` (JSONB)

### What changed

IOF control descriptions used to exist **only** inside `courses.geometry`
JSONB, as a `description` property on each control Point feature. The OCD
importer parsed them from OCAD 702000 object text and embedded them there;
the map viewer's description sheet read them back out of the geometry.

That was wrong from a data-model perspective: a description describes the
physical control site, not a course. It was duplicated per course, and it
was lost whenever a course's geometry was regenerated.

Descriptions now live on the control row:

```sql
ALTER TABLE oxygen.controls ADD COLUMN description JSONB;
```

The JSON shape is the OCAD course-setting text encoding, unchanged from
what the parser has always produced (`ControlDescription` in
`@oxygen/shared`):

```jsonc
{
  "c": "0.208",   // Column C: which of similar features
  "d": "2.001",   // Column D: control feature (e.g. Terrace)
  "g": "11.143",  // Column G: location of the flag (e.g. NE side)
  "s": "1,5",     // Column E: dimensions text (1.5 m)
  "f": "10.1"     // Column F: combination / second feature
}
```

The web `iof-symbols.ts` module maps these codes to IOF symbol SVGs per
sheet column, exactly as before.

### Migration + backfill

`20260817000000_control_description` adds the column and backfills it from
existing course geometry: for each event, every control Point feature
carrying a description is matched to the control row whose **first punch
code** equals the feature's `code`, one description per (event, code).
The backfill UPDATE is regression-tested verbatim in
`packages/api/src/__tests__/integration/control-editor.test.ts`.

### Data flow after the change

- **OCD import** (`course.importCourses`) writes parsed descriptions onto
  the control rows. XML imports carry no descriptions and leave existing
  values untouched.
- **Reads**: `control.list` / `control.detail` / `control.getById` and
  `course.controlCoordinates` all return `description`.
- **Writes**: `control.create` accepts `description`; `control.update`
  accepts `description` (null clears it). The course editor's
  **Edit description** action provides the UI (see `course-editor.md`).
- **Description sheet** (`MapViewer`): control-row descriptions arrive via
  the control overlays and take precedence; geometry-embedded descriptions
  remain as a legacy fallback only.
- **Sync**: the journal's `control.upserted` payload serializes all
  portable columns generically, so descriptions replicate to other nodes
  with no protocol change.

## 2. Editor positions and geometry regeneration

### Control positions

`control.create` and `control.update` accept `xpos` / `ypos` — **paper mm**,
the same unit as course-geometry GeoJSON (both-or-neither; validated).
WGS84 `lat`/`lng` are re-derived at write time from the uploaded map's CRS
(`loadEventCrs`, cached per event keyed by the map file's `uploaded_at`).
When there is no map or the grid is unsupported, `lat`/`lng` are set to
null and `course.controlCoordinates` keeps converting on the fly as
before.

`control.restore { id }` undoes a soft delete (needed by the editor's undo
stack). It refuses with `CONFLICT` if the code has been reused by an
active control.

### `geometrySource: "editor"`

`courses.geometry_source` gains a third value alongside `"ocd"` and
`"xml"`:

| Source   | Produced by                      | Legs |
|----------|----------------------------------|------|
| `ocd`    | OCAD course-file import          | Routed / pre-clipped |
| `xml`    | IOF XML import                   | Straight lines |
| `editor` | Any edit after import            | Straight lines |

Geometry is regenerated (in `packages/api/src/course-geometry.ts`) when:

- a control's position changes (`control.update` with `xpos`/`ypos`) — all
  non-removed courses using that control are rebuilt, including courses
  referencing it as start (`start_name` match or lowest-seq fallback) or
  finish (`finish_control_id` or lowest-seq fallback);
- a course's control sequence changes (`course.create` / `course.update`
  with `controlIds`).

The rebuild renders start + ordered controls + finish (honouring
`first_as_start` / `last_as_finish`), skips unplaced controls (position at
the map origin) while connecting across them, and rewrites:

- `geometry` — Point features + straight LineString legs (same shape as
  the XML importer's output),
- `legs` — per-leg terrain meters, `;`-joined,
- `length_m` — `sum(leg mm) × mapScale / 1000`, rounded — unless the
  caller supplied an explicit length.

Editing a course that was imported from OCAD **replaces** its routed
geometry with straight legs: the old geometry described positions/sequence
that no longer exist. Re-importing the OCD restores routed legs.

## Consequences for existing behaviour

- Editing a course's control sequence on the Courses page now regenerates
  the overlay geometry (previously the stored geometry went silently
  stale).
- Course lengths are recomputed from straight-line control distances on
  such edits when no explicit length is given.
