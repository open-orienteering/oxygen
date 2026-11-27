-- Venue shipping and lease (review package 4).
--
-- 1. journal gets a local arrival order (ingest_seq) and a "delivered to the
--    other node" mark (pushed_at). The shipper sends and pulls rows whose
--    mark is NULL in arrival order, so an entry that arrives late with an
--    old HLC is still shipped (the HLC watermark skipped it).
-- 2. allocate_event_seq() keeps event_seqs ahead of explicit seq values, so
--    rows inserted by a checkout snapshot (cloud seq values) never collide
--    with the next local create.
-- Additive: an older image ignores both columns and the trigger change.

-- ─── 1. Journal delivery mark ───────────────────────────────

ALTER TABLE "oxygen"."journal"
  ADD COLUMN "ingest_seq" BIGSERIAL,
  ADD COLUMN "pushed_at"  TIMESTAMPTZ(6);

-- Backfill (the integration test journal-backfill.test.ts runs the block
-- between the markers). The rule marks an entry delivered ONLY when it is
-- provably not this node's to ship: it was received before the acquire time
-- of the event's latest lease, so its effect is in the checkout snapshot
-- (the box never has it as unshipped, the cloud's entries before the lease
-- are baked into the box's snapshot, which is what acquireLeaseForPeer
-- marks at acquire). Everything received at or after that moment stays
-- NULL and ships once; ingest is idempotent by entry id, so a redundant
-- push or pull is harmless, whereas a wrong "delivered" mark loses entries
-- (a re-checkout wipes the box copy) or re-applies old history over newer
-- values. The old HLC watermark is not trusted: it skipped late entries.
--   - No lease rows, no sync state: not in a shipping relationship; all
--     delivered, start clean.
--   - Lease rows, an active lease, on either node: rows received before the
--     lease's acquired_at delivered; the rest NULL.
--   - A box (the event has a journal_sync_state row) whose lease is
--     released (checked in, or taken over): the same cut at the latest
--     lease's acquired_at, so a checked-in copy's unshipped tail stays
--     visible to CHECKOUT_UNSHIPPED and ships.
--   - The cloud (lease rows, no sync state) whose leases are all released:
--     all delivered; the box checked in through a barrier and the cloud's
--     own rows are no longer wanted by anyone.
--   - A sync state row without any lease: left NULL.
-- backfill:begin
UPDATE oxygen.journal j
   SET pushed_at = now()
  FROM (
    SELECT e.id AS event_id,
           l.acquired_at,
           l.released_at,
           l.id AS lease_id,
           EXISTS (SELECT 1 FROM oxygen.journal_sync_state s WHERE s.event_id = e.id) AS ships
      FROM oxygen.events e
      LEFT JOIN LATERAL (
        SELECT id, acquired_at, released_at
          FROM oxygen.event_lease
         WHERE event_id = e.id
         ORDER BY id DESC
         LIMIT 1
      ) l ON true
  ) x
 WHERE j.event_id = x.event_id
   AND j.pushed_at IS NULL
   AND CASE
         WHEN x.lease_id IS NULL THEN NOT x.ships
         WHEN x.released_at IS NULL OR x.ships THEN j.received_at < x.acquired_at
         ELSE true
       END;
-- backfill:end

-- Partial index (SQL only, Prisma cannot express it): the unshipped queue.
-- Created after the backfill so it is built over the few rows left NULL.
CREATE INDEX "journal_unshipped_idx"
  ON "oxygen"."journal" ("event_id", "ingest_seq")
  WHERE "pushed_at" IS NULL;

-- The boot-time MAX(hlc) over the whole journal (index.ts seeds the clock).
CREATE INDEX "journal_hlc_idx" ON "oxygen"."journal" ("hlc");

-- ─── 2. seq counter follows explicit seq values ─────────────

CREATE OR REPLACE FUNCTION oxygen.allocate_event_seq() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  allocated INTEGER;
BEGIN
  IF NEW.seq IS NULL OR NEW.seq = 0 THEN
    INSERT INTO oxygen.event_seqs (event_id, table_name, next_seq)
    VALUES (NEW.event_id, TG_TABLE_NAME, 2)
    ON CONFLICT (event_id, table_name)
    DO UPDATE SET next_seq = oxygen.event_seqs.next_seq + 1
    RETURNING next_seq - 1 INTO allocated;
    NEW.seq = allocated;
  ELSE
    -- An explicit seq (checkout snapshot, legacy import): the counter must
    -- end up beyond it.
    INSERT INTO oxygen.event_seqs (event_id, table_name, next_seq)
    VALUES (NEW.event_id, TG_TABLE_NAME, NEW.seq + 1)
    ON CONFLICT (event_id, table_name)
    DO UPDATE SET next_seq = EXCLUDED.next_seq
      WHERE oxygen.event_seqs.next_seq < EXCLUDED.next_seq;
  END IF;
  RETURN NEW;
END $$;

-- Repair counters that already lag behind the rows (a checked-in venue copy
-- or a snapshot import before this migration).
INSERT INTO oxygen.event_seqs (event_id, table_name, next_seq)
SELECT event_id, 'controls', MAX(seq) + 1 FROM oxygen.controls GROUP BY event_id
ON CONFLICT (event_id, table_name) DO UPDATE SET next_seq = EXCLUDED.next_seq
  WHERE oxygen.event_seqs.next_seq < EXCLUDED.next_seq;
INSERT INTO oxygen.event_seqs (event_id, table_name, next_seq)
SELECT event_id, 'courses', MAX(seq) + 1 FROM oxygen.courses GROUP BY event_id
ON CONFLICT (event_id, table_name) DO UPDATE SET next_seq = EXCLUDED.next_seq
  WHERE oxygen.event_seqs.next_seq < EXCLUDED.next_seq;
INSERT INTO oxygen.event_seqs (event_id, table_name, next_seq)
SELECT event_id, 'classes', MAX(seq) + 1 FROM oxygen.classes GROUP BY event_id
ON CONFLICT (event_id, table_name) DO UPDATE SET next_seq = EXCLUDED.next_seq
  WHERE oxygen.event_seqs.next_seq < EXCLUDED.next_seq;
INSERT INTO oxygen.event_seqs (event_id, table_name, next_seq)
SELECT event_id, 'cards', MAX(seq) + 1 FROM oxygen.cards GROUP BY event_id
ON CONFLICT (event_id, table_name) DO UPDATE SET next_seq = EXCLUDED.next_seq
  WHERE oxygen.event_seqs.next_seq < EXCLUDED.next_seq;
INSERT INTO oxygen.event_seqs (event_id, table_name, next_seq)
SELECT event_id, 'runners', MAX(seq) + 1 FROM oxygen.runners GROUP BY event_id
ON CONFLICT (event_id, table_name) DO UPDATE SET next_seq = EXCLUDED.next_seq
  WHERE oxygen.event_seqs.next_seq < EXCLUDED.next_seq;
INSERT INTO oxygen.event_seqs (event_id, table_name, next_seq)
SELECT event_id, 'teams', MAX(seq) + 1 FROM oxygen.teams GROUP BY event_id
ON CONFLICT (event_id, table_name) DO UPDATE SET next_seq = EXCLUDED.next_seq
  WHERE oxygen.event_seqs.next_seq < EXCLUDED.next_seq;
INSERT INTO oxygen.event_seqs (event_id, table_name, next_seq)
SELECT event_id, 'control_units', MAX(seq) + 1 FROM oxygen.control_units GROUP BY event_id
ON CONFLICT (event_id, table_name) DO UPDATE SET next_seq = EXCLUDED.next_seq
  WHERE oxygen.event_seqs.next_seq < EXCLUDED.next_seq;
INSERT INTO oxygen.event_seqs (event_id, table_name, next_seq)
SELECT event_id, 'map_templates', MAX(seq) + 1 FROM oxygen.map_templates GROUP BY event_id
ON CONFLICT (event_id, table_name) DO UPDATE SET next_seq = EXCLUDED.next_seq
  WHERE oxygen.event_seqs.next_seq < EXCLUDED.next_seq;
INSERT INTO oxygen.event_seqs (event_id, table_name, next_seq)
SELECT event_id, 'course_maps', MAX(seq) + 1 FROM oxygen.course_maps GROUP BY event_id
ON CONFLICT (event_id, table_name) DO UPDATE SET next_seq = EXCLUDED.next_seq
  WHERE oxygen.event_seqs.next_seq < EXCLUDED.next_seq;
INSERT INTO oxygen.event_seqs (event_id, table_name, next_seq)
SELECT event_id, 'course_objects', MAX(seq) + 1 FROM oxygen.course_objects GROUP BY event_id
ON CONFLICT (event_id, table_name) DO UPDATE SET next_seq = EXCLUDED.next_seq
  WHERE oxygen.event_seqs.next_seq < EXCLUDED.next_seq;
