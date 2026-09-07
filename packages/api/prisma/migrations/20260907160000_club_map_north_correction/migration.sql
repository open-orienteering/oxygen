-- Club-library + event map north-detection diagnostics and club rotation column.
ALTER TABLE oxygen.club_map_files
  ADD COLUMN IF NOT EXISTS rotation_correction DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS north_detection JSONB;

ALTER TABLE oxygen.map_files
  ADD COLUMN IF NOT EXISTS north_detection JSONB;
