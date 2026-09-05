# Mobile editor gestures and header polish

## Symptoms

- Fullscreen map buttons stopped responding to real mobile touches.
- The control-description editor opened invisibly behind fullscreen.
- Switching events could retain the previous viewport or show control rings
  while map tiles remained blank.
- Releasing a two-finger map gesture over a dense course could select a
  control accidentally.
- The editor dismiss button consumed its own row and did not reliably react to
  touch while fullscreen.
- The mobile header hid database status, its sync panel could paint under page
  content, and internal event slugs displaced useful creator metadata.
- Installed Chrome shortcuts could lack an application icon.

## Causes

Fullscreen one-finger panning called `preventDefault()` for touches beginning
on map toolbar buttons, suppressing the browser's synthetic click. Event-scoped
map queries share input-less React Query keys, and the viewer could initialize
from retained data before the new refetch completed. `TileLayer` also tracked
loaded/failed tiles by z/x/y without the event URL or upload version.
The description modal is mounted outside MapPanel's fullscreen subtree, which
browsers are not allowed to paint while that subtree owns fullscreen.

The first finger of a map gesture could arm the control drag handler before the
second finger arrived. The eventual `touchend` therefore looked like a control
tap. The dismiss button relied on the synthetic click generated after touch,
and the header's clipping/stacking changes also clipped its child dropdowns.
The manifest supplied only an SVG icon; Chrome's install UI expects explicit
192px and 512px PNG entries for consistent application icons.

## Fix

- Interactive map controls bypass native map gesture handling.
- The description editor is mounted through MapPanel's fullscreen-overlay
  slot, so it remains visible and interactive without leaving fullscreen.
- Event switches reset map queries; viewers remount for event/map identity;
  tile state keys include event and upload version.
- Editor-mode container resizes preserve the user's viewport rather than
  invoking fit-to-controls.
- Any two-finger gesture cancels an armed editor drag and blocks control/leg
  selection until 400 ms after movement ends.
- The dismiss button is absolutely aligned with the context menu's first row
  and handles touch-end directly.
- Mobile descriptions default off and editor selection itself never changes
  the map viewport.
- The database indicator is icon-only on mobile, header dropdowns render in a
  higher stacking context, and the truncated event-name link occupies the
  space beneath right-aligned action icons.
- Event rows show classification and creator instead of the internal slug.
- The manifest now declares app id/scope, standalone display, and 192/512 PNG
  icons; iOS also receives an Apple touch icon.

Regression coverage is in `e2e/mobile-layout.spec.ts` and
`e2e/event-selector.spec.ts`.
