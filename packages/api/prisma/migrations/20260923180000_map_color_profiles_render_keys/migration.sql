-- Colour-stack profiles, content-keyed tiles, auto-overprint-cuts toggle.

-- Event-level switch for automatic circle slits / leg gaps.
ALTER TABLE oxygen.events
  ADD COLUMN IF NOT EXISTS auto_overprint_cuts BOOLEAN NOT NULL DEFAULT true;

-- Map file colour-stack settings + content hash / render key.
ALTER TABLE oxygen.map_files
  ADD COLUMN IF NOT EXISTS color_profile TEXT NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS color_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS north_lines_below BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS file_hash TEXT,
  ADD COLUMN IF NOT EXISTS render_key TEXT;

ALTER TABLE oxygen.club_map_files
  ADD COLUMN IF NOT EXISTS color_profile TEXT NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS color_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS north_lines_below BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS file_hash TEXT,
  ADD COLUMN IF NOT EXISTS render_key TEXT;

-- Backfill content hashes (render_key is filled lazily on first tile/metadata read).
UPDATE oxygen.map_files
SET file_hash = encode(sha256(file_data), 'hex')
WHERE file_hash IS NULL;

UPDATE oxygen.club_map_files
SET file_hash = encode(sha256(file_data), 'hex')
WHERE file_hash IS NULL;

CREATE INDEX IF NOT EXISTS map_files_render_key_idx
  ON oxygen.map_files (render_key)
  WHERE render_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS club_map_files_render_key_idx
  ON oxygen.club_map_files (render_key)
  WHERE render_key IS NOT NULL;

-- Recreate map_tiles keyed by render_key (shared across events). Pure cache —
-- drop all rows; they regenerate on first view.
DROP TABLE IF EXISTS oxygen.map_tiles;

CREATE TABLE oxygen.map_tiles (
  render_key TEXT NOT NULL,
  z INT NOT NULL,
  x INT NOT NULL,
  y INT NOT NULL,
  tile_data BYTEA NOT NULL,
  PRIMARY KEY (render_key, z, x, y)
);
