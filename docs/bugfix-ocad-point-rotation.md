# Bugfix: north-oriented OCAD point symbols drew rotated objects north-up

## What happened

The C7 corpus print run (`docs/course-print.md` §11.5) failed Club-full on
four point symbols the document pipeline drew unrotated where the legacy
tiles turned each object to its angle: 504.5 / 504.7 (barrier), 512.3
(footbridge) and 519.0 (tunnel) — 25–36 % of their ink different in B9's
parity tool, canonical rendering on or off.

The importer mapped an OCAD point symbol's orientation from its flag
alone (`orientation = flags & 1 ? "object" : "north"`,
`docs/map-import.md` §3.3), and the stage draws a point object's angle
only when the symbol is `object`-oriented (`docs/map-rendering.md` §4.6).
In Club-full those four symbols, and 19 more, have the rotatable flag
clear, yet their objects carry angles — every one of the 504.5, 504.7 and
519.0 objects, 32 of 34 footbridges. Club-2026, the same club's newer
file, has the same symbols with the flag set, which is why B9's corpus run
never saw it; the other corpus maps have no rotated object on a
north-oriented symbol.

The flag is OCAD's "oriented to north" switch: it stops the user rotating
new objects, but OCAD still draws an angle an object already has. The
legacy (`ocad2geojson`) applies the angle unconditionally, and
OpenOrienteering Mapper's OCD import compensates explicitly
(`ocd_file_import.cpp`, `importObject`: a non-rotatable, non-symmetrical
point symbol is made rotatable on the first object with a non-zero angle).

## The fix

`ocadToDocumentInput` (`packages/shared/src/import/ocad-source.ts`,
`rotateFromObjectAngles`) applies Mapper's rule after reading the objects:
a north-oriented point symbol with at least one point object at a
non-zero angle becomes `orientation: "object"`, `glyph.rotatable: true`,
unless its glyph is only discs and rings centred on the origin (which look
the same at any angle). Objects at angle 0 draw as before. The stage is
unchanged. Importer `ocad-14` → `ocad-15`; the OMAP importer is unchanged
(Mapper writes a rotation only for rotatable symbols).

Club-full, the 23 affected symbols: 6 diverged before (504.7 36.28 %,
519.0 31.96 %, 512.3 26.65 %, 504.5 24.92 %, 519.3 21.31 %, 208.4
15.04 %), none after, with canonical rendering on and off.

Stored `ocad-14` documents are stale by importer version; the release's
`backfill.sh --rematch` re-imports them.

## Tests

- `packages/shared/src/import/__tests__/ocad-source.test.ts` "point
  orientation from object angles": a north-oriented symbol with a rotated
  object turns `object`; a rotatable one, one without rotated objects and
  a centred disc keep their flag; the angles reach the render bridge.
- `packages/api/src/render/__tests__/parity.test.ts` "north-oriented point
  symbols with rotated objects": `buildRotatedPointsOcad`
  (`scripts/lib/ocad-fixture.mjs`, Club-full's barrier, footbridge and
  tunnel glyphs) through reader → document → stage against the legacy,
  every kind `close` in both modes, the −84.7° footbridge laid across on
  both images. Both fail on the old importer.
- `packages/shared/src/render/__tests__/symbolise.test.ts`: an
  `object`-oriented point turns its instance by the object angle, a
  `north` one does not.
- `scripts/__tests__/ocad-fixture.test.mjs`: the reader reads the
  fixture's flags and angles back.
