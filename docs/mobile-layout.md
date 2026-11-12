# Mobile layout and touch gestures

Oxygen is primarily used on desktop during race organisation, but tablets and
phones are common at the arena. This document describes the mobile-specific
layout and gesture model introduced in 2026.

## Page zoom lock

The viewport meta tag sets `maximum-scale=1, user-scalable=no`, and the root
`html` element uses `touch-action: pan-x pan-y`. Together they prevent the
browser from pinch-zooming the whole page — which made tables and the shell
header hard to use on small screens.

Tables still scroll horizontally when needed; only page-level zoom is disabled.

## Map touch gestures

`MapViewer` attaches native non-passive `touchstart` / `touchmove` / `touchend`
listeners (React's root touch handlers are passive, so `preventDefault()` there
does not block page scroll).

| Context | One finger | Two fingers |
|---------|------------|-------------|
| Inline map on a coarse-pointer device (phone/tablet) | Scrolls the **page** vertically | Pans and pinch-zooms the **map** |
| Fullscreen map | Pans the map | Pans and pinch-zooms the map |
| Fine pointer (mouse/trackpad) | Pans the map (unchanged) | Pinch-zooms the map |

Two-finger translation and scale are applied as one transform: the geographic
point under the gesture's initial midpoint is kept under its current midpoint.
Move events are coalesced to one update per animation frame, avoiding expensive
control-overlay rerenders at raw touch-sampling rates.

On first single-finger drag over an inline map, a brief hint overlay appears
once per browser profile: "Use two fingers to move the map"
(`oxygen.map.twoFingerHintShown` in `localStorage`).

The map container uses `touch-action: pan-y` in the inline coarse-pointer case
so the browser can scroll the page natively with one finger.

## GPS “My location”

`MapViewer` exposes a crosshair **My location** button in the bottom-right
toolbar (below measure, above fullscreen):

| State | Button | Behaviour |
|-------|--------|-----------|
| Off (default) | White | No GPS watch, no marker |
| Following | Solid blue | `watchPosition` active; blue accuracy circle + dot; viewport recenters on each fix |
| Located (not following) | Blue tint | Marker stays; auto-center stopped after the user pans/zooms; tap again to re-follow |

Tapping while following turns GPS off. Permission / unavailable errors flash a
short toast and return to off. Requires a secure context (HTTPS or localhost).

Helpers: `useGeolocationWatch`, `nextLocateMode` / `accuracyRadiusPx` in
`packages/web/src/lib/locate-mode.ts`. E2E coverage lives in
`e2e/mobile-layout.spec.ts`.

## PWA session recovery (IAP)

When a dormant installed PWA wakes with an expired Google IAP cookie,
`/trpc` fails as a CORS `Failed to fetch` (no tRPC code). The competition
shell classifies that as a network-class error, shows **Reconnecting…**,
retries `competition.select` once, and may perform a guarded full reload so
the IAP cookie can refresh — it must not show **Event not found** unless the
procedure actually returns `NOT_FOUND`. See
[bugfix-pwa-iap-session-recovery.md](bugfix-pwa-iap-session-recovery.md).

## Course editor on touch

The new course editor (`vector` events, `docs/course-editor.md`) has its
own phone layout and touch rules: **[course-editor.md §10](course-editor.md#10-phone-and-tablet)** —
Field mode as the phone default, a full-bleed canvas where one finger
pans, the bottom sheet with three detents and the action bar in its peek
row, the floating `+`, and on a coarse pointer: a selected control drags
at once, an unselected one pans on a drag and moves after a 500 ms long
press, a dragged control rides 48 px above the finger with a 120 px
×2.5 loupe above it (drawn by the GL layer), hit tolerance 12 px, two fingers always pan / zoom and cancel a pending press. On a tablet (a coarse pointer with the desktop layout) one finger also drags the selected leg's bend handles and grips the same way, lifted with the loupe; the phone's Leg section stays read-only. The placement loupe toggle (the overflow menu's *Placement loupe*, F27; remembered per browser) shows the same loupe 16 px above the pin-drop crosshair while `+` → a placing tool is armed, centred on the point *Place* drops.

### Map toolbar buttons

Every toggle on the map toolbar — **Hide other controls**, **Auto slits**,
**Descriptions**, **Show progress** — is a `ToolbarButton`
(`packages/web/src/components/ToolbarButton.tsx`): an icon from
`map-icons.tsx` plus a label that is visible from `sm` up and collapses to the
icon alone below it. The label always feeds `aria-label` and the tooltip, so
the accessible name (and `getByRole("button", { name })` in E2E) is the same
on both breakpoints. Undo / redo are icon-only everywhere. On phones the
buttons get `p-2` and 20px icons — a ~36px touch target — instead of the
12px `⟲` / `⟳` glyphs the editor used to ship. Without this the row of text
buttons did not fit 390px and **Auto slits** rendered on top of
**Descriptions**.

Above `sm` the course editor's row has a second, width-based rule (F29,
[course-editor.md](course-editor.md) §2 "Top bar"): `map-toolbar` is a CSS
container (`@container/toolbar`), and below 1600 px of row (its content width) the editor's
labels (Hide other controls, Auto slits, Hide descriptions, Export and the
course picker's *Course* word) are hidden through `ToolbarButton`'s
`labelClassName`; below 1170 px the Course / Layout / Field switch shows its
icons alone. The accessible names stay, as on a phone. Other pages' map
panels keep the `sm` rule only.

The selected-control readout keeps the code and SRR/radio badges on phones
but hides the millimetre position (`hidden sm:inline`).

The **North lines under course purple** checkbox and the colour-stack
profile select are gone (E4a): the course layer sorts into the map
document's own colour stack ([course-layer.md](course-layer.md) §1), so
neither the editor's map-info dialog (the map footer's successor since
P6) nor the club-library map card carries a colour-stack control.

### Map layout / template editor header

Deleted with `MapLayoutEditor` in E4c: *Edit layout* and *Edit template
layout* open the course editor's Layout mode, whose phone layout is the
course editor's (`course-editor.md`, `course-layout.md`).

### Controls page toolbar

The count / AIR+ / awake-hours group and the **Program Controls** / **Read
Controls** buttons are two `flex-wrap` groups inside a wrapping row
(`data-testid="controls-toolbar"`), so on a phone the station buttons drop to
their own line instead of pushing the page wider than the screen.

## Shell header (narrow viewports)

Below the `sm` breakpoint (~640px):

- Status pills (database, kiosk, printer, SI reader, start screen, show-map) are
  **icon-only**; labels stay in `title` / `aria-label`.
- The truncated event name beside the back arrow links to the Event page.
  The action group is right-aligned above that name, so it cannot increase the
  page width and naturally covers the truncated end when space runs out.
- The signed-in user moves to the More menu; database load and venue lease
  details remain available from their compact icons.
- Only the **tab row** stays `sticky`; the name row scrolls away with the page
  so map-heavy pages gain vertical space while navigation remains one thumb-reach
  away.

## Map chrome

- No map footer on any page (P6): `MapPanel`'s `showMapInfo` row (file name,
  north lines, **Review symbols**, **Replace map**, **From club library**) is gone
  with the prop. On the desktop course editor all of it, with the map scale, is
  the map-info dialog behind the top bar's map icon
  ([course-editor.md](course-editor.md) §2); the phone editor has no map icon
  (its peek line keeps the scale, §10; a phone entry is pending). Uploading a map
  on an event with no map still uses the drop zone on every page
  (`components/useMapReplace.ts`, shared with the dialog).
- Inline maps on narrow viewports use
  `height: min(<caller px>, calc(100dvh - 8rem))` so the map nearly fills the
  screen; one-finger page scroll over the map reaches content above.

## Event-scoped map state

Switching events clears the event-scoped map metadata/control queries before
the next routed page mounts. `MapViewer` is also keyed by event, upload version,
and document hash, so a previous viewport cannot initialize a different event.
Event tRPC requests include the slug in both the authorization header and an
`event` query parameter. The API trusts the header; the query parameter exists
so the service worker's URL-based cache cannot mix responses between events.

The map itself is the event's pinned document, addressed by its content hash
(`/api/map-documents/<hash>`, the event and kiosk key as headers): two events
on the same club map share one cached document, and a re-upload pins a new
hash, so nothing stale is drawn (`docs/map-storage.md` §7.1). The tile cache
of the retired tile layer is deleted on start (E4b, `lib/legacy-caches.ts`).

## Event list and installation

Event rows show their Eventor classification (or **Unclassified**) instead of
the internal event slug. Creator attribution remains visible and truncates on
mobile.

The manifest uses PNG icons at 192×192 and 512×512, with an explicit app id,
scope, and `display: standalone`. A correctly installed Chrome PWA therefore
opens without browser address-bar chrome. If Chrome still shows an address bar,
the site was added as a normal home-screen shortcut rather than installed as a
PWA; uninstall the shortcut and install again after the updated manifest loads.

The manifest link uses `crossorigin="use-credentials"`. Production is protected
by Google IAP, so the browser must include the existing IAP session cookie when
fetching `/manifest.webmanifest`; otherwise IAP redirects the anonymous request
to Google Accounts and the cross-origin OAuth response is rejected by CORS.

## Related files

| Area | File |
|------|------|
| Viewport meta | `packages/web/index.html` |
| Root touch-action | `packages/web/src/index.css` |
| Map gestures | `packages/web/src/components/MapViewer.tsx` |
| GPS locate | `packages/web/src/lib/locate-mode.ts`, `useGeolocationWatch` |
| Session recovery | `packages/web/src/lib/session-recovery.ts`, `CompetitionShell` |
| Map height / toolbar / drop zone | `packages/web/src/components/MapPanel.tsx`, `useMapReplace.ts`, `ClubMapPicker.tsx` |
| Editor map info (desktop) | `packages/web/src/pages/editor/MapInfoDialog.tsx`, `lib/editor/map-info.ts` |
| Toolbar buttons + icons | `packages/web/src/components/ToolbarButton.tsx`, `map-icons.tsx`, `top-bar-collapse.ts` (F29) |
| Controls page toolbar | `packages/web/src/pages/ControlsPage.tsx` |
| Shell header | `packages/web/src/pages/CompetitionShell.tsx` |
| E2E | `e2e/mobile-layout.spec.ts` (the editor's phone layout itself is `e2e/field-mode.spec.ts` and the touch describe of `e2e/course-editor.spec.ts`, whose "F23" describe drives a tablet's bend drags; E3 deleted the legacy editor's phone tests), `e2e/session-recovery.spec.ts` |
