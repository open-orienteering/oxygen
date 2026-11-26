-- Package 8 (RES-08, DB-12): backup-memory punches were stored as the
-- station's clock time (absolute deciseconds since midnight) in the
-- ZeroTime-relative `punches.time` column, and a pushed punch's `manual`
-- mirror copied that value. Every reader adds ZeroTime, so such a punch read
-- back 9 h late (with the default 09:00 ZeroTime) and a rescue push made the
-- result worse. From this release the import stores `time - zero_time`.
--
-- Repair, on the node that imported them:
--   1. the `manual` mirrors of pushed backup rows (same event, card, control
--      and time as a backup row with is_original = false), first, while the
--      backup rows still carry the old value to match on;
--   2. the backup rows themselves.
-- Rows with time 0 ("no time") stay. A node that only received the rows
-- through the journal stored them differently and is not touched here
-- (docs/bugfixes/zerotime-followups.md).
--
-- Data only, no schema change: the previous image keeps working (it would
-- go on writing new backup rows in the old base until it is replaced).

UPDATE "oxygen"."punches" AS m
   SET "time" = m."time" - e."zero_time"
  FROM "oxygen"."events" AS e
 WHERE e."id" = m."event_id"
   AND m."source" = 'manual'
   AND m."time" <> 0
   AND EXISTS (
     SELECT 1 FROM "oxygen"."punches" AS b
      WHERE b."event_id" = m."event_id"
        AND b."source" = 'backup_memory'
        AND b."is_original" = false
        AND b."card_no" = m."card_no"
        AND b."control_code" = m."control_code"
        AND b."time" = m."time"
   );

UPDATE "oxygen"."punches" AS b
   SET "time" = b."time" - e."zero_time"
  FROM "oxygen"."events" AS e
 WHERE e."id" = b."event_id"
   AND b."source" = 'backup_memory'
   AND b."time" <> 0;
