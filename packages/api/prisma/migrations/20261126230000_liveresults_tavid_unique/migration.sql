-- Package 16 (MC-29): one Oxygen event per LiveResults competition. Two
-- events sharing a `liveresults_tavid` would push into (and delete from) the
-- same remote competition. NULLs stay allowed (an event never pushed).
--
-- Refuse rather than silently clear a duplicate: the operator decides which
-- event keeps the competition (UPDATE the other one's tavid to NULL), then
-- re-runs the migration.
DO $$
DECLARE dupes TEXT;
BEGIN
  SELECT string_agg(format('tavid %s: events %s', liveresults_tavid, ids), '; ')
    INTO dupes
    FROM (
      SELECT liveresults_tavid, string_agg(id::text, ', ' ORDER BY id) AS ids
        FROM "oxygen"."events"
       WHERE liveresults_tavid IS NOT NULL
       GROUP BY liveresults_tavid
      HAVING count(*) > 1
    ) d;
  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION 'Several events share a LiveResults competition (%). Set liveresults_tavid to NULL on all but one, then migrate again.', dupes;
  END IF;
END $$;

CREATE UNIQUE INDEX "events_liveresults_tavid_key" ON "oxygen"."events"("liveresults_tavid");
