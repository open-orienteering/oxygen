-- Make runners.card_no nullable (NULL = "no card"), retire the 0 sentinel, and
-- enforce one-card-per-event with a PARTIAL unique index. Postgres treats NULLs
-- as distinct, so any number of cardless runners coexist; the `WHERE removed =
-- false` predicate lets a soft-deleted runner free its card for reuse.
--
-- Written idempotently so it is safe to re-run during development recovery.

-- Refuse to run rather than ever silently destroying a conflicting row. On a
-- clean database this passes; if duplicate active cards ever exist, the
-- migration aborts so they can be resolved by hand first.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "oxygen"."runners"
    WHERE "removed" = false AND "card_no" IS NOT NULL AND "card_no" <> 0
    GROUP BY "event_id", "card_no" HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate active (event_id, card_no) in runners — resolve before adding the unique index';
  END IF;
END $$;

-- AlterColumn: drop the NOT NULL constraint and the default FIRST, so the
-- sentinel-to-NULL update below is permitted.
ALTER TABLE "oxygen"."runners"
  ALTER COLUMN "card_no" DROP NOT NULL,
  ALTER COLUMN "card_no" DROP DEFAULT;

-- Sentinel 0 -> NULL (semantics-preserving: 0 always meant "no card").
UPDATE "oxygen"."runners" SET "card_no" = NULL WHERE "card_no" = 0;

-- The partial unique index supersedes the old non-unique (event_id, card_no)
-- index and also serves removed = false lookups.
DROP INDEX IF EXISTS "oxygen"."runners_event_id_card_no_idx";
DROP INDEX IF EXISTS "oxygen"."runners_event_id_card_no_key";
CREATE UNIQUE INDEX "runners_event_id_card_no_key"
  ON "oxygen"."runners"("event_id", "card_no")
  WHERE "removed" = false;
