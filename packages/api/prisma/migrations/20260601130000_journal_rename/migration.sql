-- Rename event_log -> journal and add the offline-first columns (hlc,
-- schema_version, actor_id); rename applied_at -> received_at. The table is the
-- append-only journal (CRDT wire format). See docs/offline-architecture.md.
--
-- Written idempotently and tolerant of historical index/constraint name
-- divergence (some environments were `db push`-seeded with Prisma-convention
-- names, others migrate-deployed with the init migration's hand-picked names),
-- so it converges any of them to the same final shape.

-- Rename the table if it is still event_log.
DO $$ BEGIN
  IF to_regclass('oxygen.event_log') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE "oxygen"."event_log" RENAME TO "journal"';
  END IF;
END $$;

-- New offline-first columns.
ALTER TABLE "oxygen"."journal" ADD COLUMN IF NOT EXISTS "actor_id" UUID;
ALTER TABLE "oxygen"."journal" ADD COLUMN IF NOT EXISTS "hlc" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "oxygen"."journal" ADD COLUMN IF NOT EXISTS "schema_version" INTEGER NOT NULL DEFAULT 1;

-- applied_at -> received_at (only if not already renamed).
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'oxygen' AND table_name = 'journal' AND column_name = 'applied_at'
  ) THEN
    EXECUTE 'ALTER TABLE "oxygen"."journal" RENAME COLUMN "applied_at" TO "received_at"';
  END IF;
END $$;

-- Backfill HLC for any pre-existing rows from their wall clock
-- (physical_ms << 16, logical 0) — matches resolveHlc()'s legacy synthesis.
UPDATE "oxygen"."journal"
  SET "hlc" = ((EXTRACT(EPOCH FROM "client_timestamp") * 1000)::bigint << 16)
  WHERE "hlc" = 0;

-- Drop the legacy secondary indexes by any historical name, then recreate
-- them with canonical names alongside the new HLC index.
DROP INDEX IF EXISTS "oxygen"."event_log_event_time_idx";
DROP INDEX IF EXISTS "oxygen"."event_log_event_type_idx";
DROP INDEX IF EXISTS "oxygen"."event_log_event_id_client_timestamp_idx";
DROP INDEX IF EXISTS "oxygen"."event_log_event_id_type_idx";
DROP INDEX IF EXISTS "oxygen"."journal_event_id_hlc_idx";
DROP INDEX IF EXISTS "oxygen"."journal_event_id_client_timestamp_idx";
DROP INDEX IF EXISTS "oxygen"."journal_event_id_type_idx";
CREATE INDEX "journal_event_id_hlc_idx" ON "oxygen"."journal"("event_id", "hlc");
CREATE INDEX "journal_event_id_client_timestamp_idx" ON "oxygen"."journal"("event_id", "client_timestamp" DESC);
CREATE INDEX "journal_event_id_type_idx" ON "oxygen"."journal"("event_id", "type");

-- Carry the PK / FK names over to the new table name if they still reflect the
-- old one (RENAME CONSTRAINT has no IF EXISTS, so guard each).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_log_pkey' AND connamespace = 'oxygen'::regnamespace) THEN
    EXECUTE 'ALTER TABLE "oxygen"."journal" RENAME CONSTRAINT "event_log_pkey" TO "journal_pkey"';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_log_event_id_fkey' AND connamespace = 'oxygen'::regnamespace) THEN
    EXECUTE 'ALTER TABLE "oxygen"."journal" RENAME CONSTRAINT "event_log_event_id_fkey" TO "journal_event_id_fkey"';
  END IF;
END $$;
