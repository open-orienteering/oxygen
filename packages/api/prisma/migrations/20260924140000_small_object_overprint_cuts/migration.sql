-- Existing editor geometry was decorated by v1, which cut long black line
-- and area objects. Keep those rows at v1 so the first geometry read
-- rebuilds every editor course with the small-object-only v2 algorithm.
ALTER TABLE oxygen.events
  ADD COLUMN overprint_cuts_version INT NOT NULL DEFAULT 1;

-- Newly created events already use v2.
ALTER TABLE oxygen.events
  ALTER COLUMN overprint_cuts_version SET DEFAULT 2;
