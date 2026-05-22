-- Last successful Eventor sync timestamp (NULL = never synced).
ALTER TABLE oxygen.events
  ADD COLUMN eventor_last_sync TIMESTAMPTZ;
