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

-- Partial index (SQL only, Prisma cannot express it): the unshipped queue.
CREATE INDEX "journal_unshipped_idx"
  ON "oxygen"."journal" ("event_id", "ingest_seq")
  WHERE "pushed_at" IS NULL;

-- Backfill: an event without an active lease is not in a shipping
-- relationship; start clean. An event with an active lease re-pushes its
-- whole journal once (deduplicated by entry id, and it heals entries the
-- old HLC watermark skipped).
UPDATE "oxygen"."journal" j
   SET "pushed_at" = now()
 WHERE NOT EXISTS (
   SELECT 1 FROM "oxygen"."event_lease" l
    WHERE l."event_id" = j."event_id" AND l."released_at" IS NULL
 );

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
