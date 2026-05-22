-- Add per-course OCAD/IOF geometry storage.
-- `geometry` is GeoJSON FeatureCollection for the course's controls + legs.
-- `geometry_source` records which parser produced it ('ocd' | 'xml').
ALTER TABLE oxygen.courses
  ADD COLUMN geometry JSONB,
  ADD COLUMN geometry_source TEXT NOT NULL DEFAULT '';
