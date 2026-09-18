# Course-map control roles and corrected georeference

## Symptoms

- All-controls PDFs drew start and finish rows as numbered control circles.
- For maps with a manual rotation correction, the Controls page could place
  every control roughly 150–200 metres away while the course editor remained
  aligned.

## Causes

The all-controls resolver discarded `controls.status` and assigned
`type = "control"` to every row.

The event CRS cache parsed the raw OCAD CRS but did not apply
`map_files.rotation_correction`. Some readers trusted previously persisted
`lat` / `lng`, while the map and course geometry used corrected calibration.
Course import alignment also applied the correction a second time after
loading the event CRS.

## Fix

All-controls queries now include status and preserve `start` / `finish` roles,
which makes the shared overprint renderer emit the triangle and double circle
without numeric labels.

`loadEventCrs()` now returns the corrected CRS and keys its cache by both map
upload timestamp and correction. Map upload and rotation changes recompute
positioned controls' WGS84 coordinates from authoritative `xpos` / `ypos`.
The Controls-page query also derives positioned rows from the current CRS, so
legacy stale coordinates cannot reappear. Course imports consume that same
corrected CRS without applying an extra correction.

For an existing affected event, saving its current rotation correction once
re-persists all positioned control coordinates.
