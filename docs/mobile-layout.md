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

The course editor shares the map gesture model above. In addition:

- **Tap a control** — selects it and opens the floating context menu.
- **Drag a control** — moves it (same local-drag + `onMoveEnd` path as mouse).
- **Tap a course leg** — inserts at that leg (`onLegClick`).
- **Tap empty map** — anchors the phantom selection menu.
- **Dismiss (×)** — in the context menu; mirrors the keyboard Escape cascade
  (phantom → selection → course).

Control and leg hit targets use `touch-action: none` so editor gestures do not
scroll the page underneath. A two-finger map gesture cancels any armed control
tap and suppresses editor selections for 400 ms after movement, giving both
fingers time to leave the screen. Descriptions start hidden below `sm`.

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

- The map footer (file name, **Replace map**, **From club library**) is hidden
  on all pages except the **Course Editor**, via `MapPanel`'s `showMapInfo` prop.
  Uploading a map on an event with no map still uses the drop zone on every page.
- Inline maps on narrow viewports use
  `height: min(<caller px>, calc(100dvh - 8rem))` so the map nearly fills the
  screen; one-finger page scroll over the map reaches content above.

## Event-scoped map and tile state

Switching events clears the event-scoped map metadata/control queries before
the next routed page mounts. `MapViewer` is also keyed by event, upload version,
and bounds, so a previous viewport cannot initialize a different event.
Event tRPC requests include the slug in both the authorization header and an
`event` query parameter. The API trusts the header; the query parameter exists
so the service worker's URL-based cache cannot mix responses between events.

Tile caching supports multiple events at once:

- Browser cache URLs contain the event `nameId`, z/x/y, and uploaded-map
  version: `/api/map-tile/<nameId>/<z>/<x>/<y>?v=<uploadedAt>`.
- Server-side `map_tiles` rows use the event database ID plus z/x/y.
- `TileLayer` load/error keys include the full event URL and version, preventing
  one event's empty or failed tile from suppressing the same z/x/y tile in
  another event.

Responses are browser-cacheable for seven days. Uploading/replacing a map
changes `v`, so the new images do not collide with the prior browser entries.

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
| Map footer / height | `packages/web/src/components/MapPanel.tsx` |
| Shell header | `packages/web/src/pages/CompetitionShell.tsx` |
| Editor dismiss wire-up | `packages/web/src/pages/CourseEditorPage.tsx` |
| E2E | `e2e/mobile-layout.spec.ts`, `e2e/session-recovery.spec.ts` |
