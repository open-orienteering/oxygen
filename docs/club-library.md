# Club library

Club-wide assets that are copied into events rather than living only on one
event. Identity (when `AUTH_MODE` is on) comes from the same invite-only
`users` table as the rest of Oxygen — see [authentication.md](authentication.md).

The library lives on the **Settings** page (`/settings`), reached from the
button under the event list on the start page. Its four tabs — Maps,
Controls, Classes, Groups — are open to any signed-in user; three further
tabs (Users, Eventor, Maintenance) are instance-admin only. Users and the
Eventor API keys are described in [authentication.md](authentication.md)
and [features.md](features.md#eventor-api-keys).

## Maps

Operators upload OCAD (`.ocd`) base maps once on **Settings → Maps**.
Each entry is a `club_maps` series (identified by its UUID) whose first
`club_map_versions` row is written when the upload's import job finishes
([map-storage.md §6.5](map-storage.md)): the version names the original
file (`map_sources`) and the imported map document, and the card's
thumbnail is that document's (`/api/map-documents/<hash>/thumbnail.png`).
Metadata the document does not carry yet (WGS84 bounds, north offset,
north-line diagnostics) and the PNG thumbnail of entries without a
document come from the legacy `club_map_files` row that every library
mutation keeps in step with the series until slice F retires it. The
file's ScalePar georeference is taken as authoritative — there is no
correction input. Instead the card shows a **north lines** badge: the
angle between the map's drawn magnetic-north lines (ISOM 601) and today's
magnetic north, evaluated live from the World Magnetic Model. Declination
drifts ≈ 0.1–0.2°/yr in Sweden, so an older map's lines go stale; at ≥ 1°
the badge turns amber as a hint to redraw them before printing. On-screen
orientation follows the drawn north lines regardless (`northOffset` fold,
see [bugfix-auto-north-correction-gps-offset.md](bugfix-auto-north-correction-gps-offset.md)).
Parse or import failure is non-fatal: the entry is kept and listed with
its import state ("Import failed" / "Importing…"), scale and bounds stay
empty, the unavailable thumbnail is hidden, and the entry can be neither
downloaded nor copied into an event until a version exists (the backfill
retries it). Entries whose `club_map_files` row predates the series appear
only once the map-document backfill has run (`pnpm map:backfill` or
Settings → Maintenance → **Map documents**); a release containing this
change requires that run first.

Rows uploaded before north-line diagnostics existed are backfilled lazily:
the first `clubMap.list` read parses the linked legacy row's blob, runs the north
analysis, and persists it (an unparseable file persists an all-null result
so it is not re-parsed on every read). Event map rows get the identical
backfill on the first `course.mapMetadata` read. "No magnetic north lines
found" therefore always means the analysis actually ran and found none —
never "not analysed yet".

**Review symbols** on a card opens the import review of the version's
document (`/settings/map-review/<document hash>?clubMap=<series>`,
[map-symbols.md §8.7](map-symbols.md)); review is expected for club maps,
so the card also shows an amber **N symbols to review** chip while the
document still has suggested matches (`clubMap.list[].review`, from the
import report). There a reviewer accepts a suggestion, picks another
library symbol, or keeps the file's own symbol; **Apply** records the
decisions as club symbol decisions and imports the file again, and **Use
this version** moves the version's document in place, so the card's
thumbnail follows. Decisions are club-wide: every map of the instance
with the same symbol (number and drawing) follows them on its next
import, event maps included ([map-symbols.md §8.5](map-symbols.md)).
Events that already copied the map keep their own pinned document. The
same page downloads and uploads the decisions as an OpenOrienteering
Mapper CRT.

The list is global for the instance (one owning club). Anyone who can sign in
can upload and rename. Delete is allowed for the entry's creator
(`club_maps.created_by`) or an instance admin, download for the version's
uploader or an instance admin (`AUTH_MODE=off` skips both checks). Delete
removes the series and its versions only; the stored file and document stay
until the storage GC collects whatever no event still uses
([map-storage.md §8](map-storage.md)).

### OCAD source files

The `.ocd` blob is the club's map. Tiles and course overprints are rendered
views and stay available to whoever can run the race; the source file does
not. `map_files.from_club_library` is set when an event adopts a library
map via **From club library**, and cleared if the event later uploads its
own file. That flag gates:

- `course.downloadMap` — event managers may download a map the event
  uploaded itself; a club-library copy requires an instance admin.
- `/api/backup/event` — same rule, because the dump includes
  `map_files.file_data`.
- `clubMap.download` — the version's uploader or an instance admin, the
  same rule as the club clause of `GET /api/map-sources/:hash`.

### Copy-on-use

On an event map panel, **From club library** copies the chosen entry's latest
version (its original file and the series' colour and rotation settings) into that
event's `map_files` row and runs the same pipeline as a direct upload
(`applyEventMap`): replace the previous map, drop `map_tiles` /
`rendered_maps`, fire map-upload listeners, rebuild `geometrySource: "editor"`
course overlays; then it pins `map_files.club_map_version_id` to that version. The event keeps an independent copy; later library rename or
delete does not change events that already copied the map (delete only clears
the event's `club_map_version_id`). Entries without a version are shown
disabled in the picker with their import state.

### Route

`settings`, `library`, and `admin` are all reserved slugs
(`RESERVED_EVENT_SLUGS` in `packages/api/src/db.ts`, mirrored by the header
logic in `packages/web/src/main.tsx`). Creating an event named after one of
them is rejected so it cannot shadow the page. `/library` and `/admin/users`
still resolve — they redirect to `/settings` and `/settings?tab=users`.

## Controls

The club's physical punching units live as **series** on the Controls tab of
**Settings**. Each series has a name, optional lender (`owner_name` /
borrowed flag), a `priority` (ascending allocation order), and a list of
codes unique **within that series** (two clubs can share a number; the event
skips codes already placed).

Codes 1–1023. Bulk add is a closed range of at most 500 codes; duplicates in
that series are skipped. Inactive rows (lost/broken) stay in the library but
are omitted from allocation. SRR-flagged units map to `internal_radio` when
the course editor places them — planners can still change radio type on the
Controls page (`public_radio` is not an inventory type).

### Allocation

`controlSeries.allocation` flattens active codes by series priority then
code. The course editor's `nextSeriesControlCode` picks the first unused
entry. With no series, or after the inventory is exhausted, it falls back to
the old “smallest unused ≥ 31” heuristic and shows a one-time notice.

The course editor exposes the allocation in a standalone collapsible
**Inventory** card, grouped by series with used/free and SRR state. An
**Assign codes from** selector can pin allocation to one series (its free
codes are used first, then priority order once exhausted). The **Radio**
action can swap a non-SRR control to the first free SRR code after inline
confirmation; see [course-editor.md](course-editor.md).

Later library edits do not change controls already placed in an event.

## Classes

The **Classes** tab stores the club's recurring class catalogue: name, sex and
age bounds, type, free-start/no-timing/direct-registration flags, and sort
order. Race-specific settings (entry fee, maximum time) are deliberately not
part of presets — set those per event on the Classes page after bulk-adding.
Any signed-in club member can curate presets. Preset sex
is restricted to open (`""`), men (`M`), or women (`F`); event classes keep
their broader legacy-compatible value handling.

On an event's Classes page, **Add from club presets** selects any number of
presets and creates only names that are not already active in the event. Every
setting is copied, but no course is assigned. The copy and one
`class.upserted` journal entry per new class commit in the same transaction.
Existing names are reported as skipped. Later edits or deletion of a preset do
not change event classes already created from it.

## Groups

The **Groups** tab defines club user groups — named sets of invited users
that event admins can grant a role to in one step (the permissions panel on
the Event page offers **User** / **Club group** as the grant subject).
Membership is resolved when capabilities are checked, so adding or removing
a member applies immediately to every event where the group holds a role.
Deleting a group removes its event grants with it.

Group management (create, rename, delete, membership) is instance-admin
only, because membership directly gates event permissions. Everyone signed
in can view the tab. See [authentication.md](authentication.md) for the
data model.

Group members must already be in the invite-only `users` table. If an admin
tries to add an unknown email, the Groups tab keeps the error visible and
offers **Invite and add**, which creates the user and retries the membership
change. The tab also links admins to the **Users** tab for bulk invite
management.

## Settings tabs for instance admins

Two tabs appear only when the signed-in user is an instance admin (with
`AUTH_MODE=off` they always appear):

- **Users** — invite, rename, grant/revoke instance admin, deactivate. The
  same table as the old `/admin/users` page. See
  [authentication.md](authentication.md).
- **Maintenance** — **Clean up deleted records** permanently removes every
  soft-deleted event and cascades its data away. This used to sit in the
  start-page footer where every user could see it, even though the
  underlying `competition.purgeDeleted` procedure has always been
  admin-only.
