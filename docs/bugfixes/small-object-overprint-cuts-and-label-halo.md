# Bugfix: small-object cuts and control-number contrast

## Problem

The first automatic overprint-cut implementation opened purple over
every configured black line and area object. After IOF colour stacking
landed, those cuts were unnecessary: cliffs, paths, walls and buildings
already render above lower purple. Cutting them fragmented circles and
legs without improving readability.

Knolls had the opposite inconsistency. They slit control circles but
were explicitly skipped by leg gaps, so a leg could still hide the same
small feature.

Control numbers also had no knockout. Purple text over dense map ink
could be hard to read, especially at print scale.

## Fix

- Automatic circle slits and leg gaps now apply only to OCAD point
  objects with ISOM numbers 109, 110, 203, 204, 205 or 207.
- Knolls and compact rocks use the same rule for circles and legs.
- Long line and area objects never create automatic cuts.
- Interactive and print/PDF control numbers receive an always-on white
  halo with stroke width 12 % of the number font size. SVG
  `paint-order="stroke fill"` keeps the purple glyph crisp.

## Existing events

Cuts are stored in editor course GeoJSON, so changing only the algorithm
would leave old building/path cuts visible indefinitely.
`events.overprint_cuts_version` solves that:

- migration marks existing events as v1;
- new events default to v2;
- the first geometry read for a v1 event rebuilds every
  `geometrySource: "editor"` course and advances the event to v2;
- imported OCD/XML geometry is never rewritten.

## Coverage

- Unit tests reject line/area cuts and verify knoll gaps.
- Integration tests verify building legs stay whole, boulder legs gap,
  and v1 stored geometry migrates lazily.
- Shared print-overlay tests assert the white halo.
- Course-editor E2E asserts the interactive label halo.
