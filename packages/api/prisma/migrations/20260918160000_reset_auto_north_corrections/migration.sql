-- Undo automatically applied north corrections.
--
-- Import-time north detection used to treat the angle between the drawn
-- ISOM 601.x meridian lines and today's magnetic declination as a
-- georeference error and wrote it into rotation_correction. That angle is
-- really the age of the north lines (declination drifts ~0.15°/yr in
-- Sweden); the OCAD ScalePar georeference was right all along. On
-- Nackareservatet the auto value (+1.7°) displaced GPS by ~190 m.
--
-- Rows are recognisable: north_detection.shouldAutoApply = true and the
-- stored correction equals north_detection.suggestedCorrectionDeg. Manual
-- values (set through course.setMapRotation / clubMap.setRotation) do not
-- satisfy both and are left alone.
--
-- Derived metadata cannot be recomputed in SQL (it needs the OCAD parser),
-- so event map rows get their derived columns cleared; course.mapMetadata
-- treats an all-null row as legacy and re-derives it — with correction 0
-- — on first read, then re-syncs positioned control lat/lng. Tile caches
-- are dropped so the next render warps with the file's own CRS.
--
-- No temp table: prisma migrate runs statements one by one, so the
-- selection predicate is repeated. Caches go first because the UPDATE
-- makes the rows stop matching.

DELETE FROM oxygen.map_tiles t
USING oxygen.map_files m
WHERE t.event_id = m.event_id
  AND m.rotation_correction <> 0
  AND m.north_detection IS NOT NULL
  AND (m.north_detection->>'shouldAutoApply')::boolean IS TRUE
  AND (m.north_detection->>'suggestedCorrectionDeg') IS NOT NULL
  AND abs(m.rotation_correction - (m.north_detection->>'suggestedCorrectionDeg')::double precision) < 1e-6;

DELETE FROM oxygen.rendered_maps rm
USING oxygen.map_files m
WHERE rm.event_id = m.event_id
  AND m.rotation_correction <> 0
  AND m.north_detection IS NOT NULL
  AND (m.north_detection->>'shouldAutoApply')::boolean IS TRUE
  AND (m.north_detection->>'suggestedCorrectionDeg') IS NOT NULL
  AND abs(m.rotation_correction - (m.north_detection->>'suggestedCorrectionDeg')::double precision) < 1e-6;

UPDATE oxygen.map_files m
SET rotation_correction = 0,
    scale = NULL,
    bounds = NULL,
    north_offset = NULL,
    calibration = NULL,
    -- Bump the stamp: busts the client mapMetadata / tile URL cache and
    -- the API's per-event CRS cache.
    uploaded_at = now(),
    north_detection = m.north_detection || jsonb_build_object(
      'autoCorrectionResetAt', to_jsonb(now()),
      'autoCorrectionResetFromDeg', to_jsonb(m.rotation_correction)
    )
WHERE m.rotation_correction <> 0
  AND m.north_detection IS NOT NULL
  AND (m.north_detection->>'shouldAutoApply')::boolean IS TRUE
  AND (m.north_detection->>'suggestedCorrectionDeg') IS NOT NULL
  AND abs(m.rotation_correction - (m.north_detection->>'suggestedCorrectionDeg')::double precision) < 1e-6;

-- Club-library rows: only the correction and the correction-derived
-- columns matter. bounds / north_offset are informational there (no UI
-- reads them) and there is no lazy backfill, so they are cleared rather
-- than left with a shifted value.
UPDATE oxygen.club_map_files c
SET rotation_correction = 0,
    bounds = NULL,
    north_offset = NULL,
    north_detection = c.north_detection || jsonb_build_object(
      'autoCorrectionResetAt', to_jsonb(now()),
      'autoCorrectionResetFromDeg', to_jsonb(c.rotation_correction)
    )
WHERE c.rotation_correction <> 0
  AND c.north_detection IS NOT NULL
  AND (c.north_detection->>'shouldAutoApply')::boolean IS TRUE
  AND (c.north_detection->>'suggestedCorrectionDeg') IS NOT NULL
  AND abs(c.rotation_correction - (c.north_detection->>'suggestedCorrectionDeg')::double precision) < 1e-6;
