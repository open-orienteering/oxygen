-- Package 2 (RES-01, SI-10): flags that mark a hand-set status / finish so a card re-read never overwrites them.
-- Additive, no backfill: an existing DQ is protected by its status alone.
ALTER TABLE "oxygen"."runners" ADD COLUMN "status_manual" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "oxygen"."runners" ADD COLUMN "finish_manual" BOOLEAN NOT NULL DEFAULT false;
