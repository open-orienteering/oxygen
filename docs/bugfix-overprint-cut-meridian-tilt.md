# Bugfix: overprint cut slits skewed by meridian tilt

## Symptom

Automatic circle slits on the course editor / map viewer were rotated a
few degrees clockwise of the black feature they were meant to clear.
On `Ny_karta_test` the bias was ~3.3° — enough that a boulder on the
north rim of a control looked like it sat in the middle of purple ink.

Print/PDF maps were fine: map and overlay share one
`windowRotationDeg`, so cut angles and map features stay co-rotated.

## Cause

Stored cut angles are paper-relative (compass degrees in the OCAD
millimetre plane). The viewer must rotate them by the same amount it
rotates the base map so slits land on features after true-north
alignment.

`MapViewer` added `northOffset` to every cut angle. That value is
`displayNorthOffsetDeg` = paper-to-true-north bearing **plus** the
median meridian-line tilt (`meridian.medianTiltDeg`). The tilt is needed
so drawn 601.x north lines stand vertical on screen, but cuts only need
the paper→true-north part. Folding the tilt in rotated every slit by
that extra angle.

## Fix

- Pure helper `cutRotationDeg(northOffset, tiltDeg)` in
  `packages/api/src/map-north.ts`:
  `northOffset - (tiltDeg ?? 0)`, null when `northOffset` is null.
- `course.mapMetadata` returns `cutRotationDeg`.
- `MapViewer` uses `cutRotationDeg` for the slit `adj` computation;
  map/tile rotation still uses `northOffset`.

## Tests

- Unit: `map-north.test.ts` (`cutRotationDeg`).
- Integration: `mapMetadata.cutRotationDeg` asserted alongside profile
  changes in `map-tiles.test.ts`.
- E2E: existing cut/gap assertions in `course-editor.spec.ts` still
  pass; they plant a boulder due north of control 79 so any residual
  tilt bias would miss the slit.
