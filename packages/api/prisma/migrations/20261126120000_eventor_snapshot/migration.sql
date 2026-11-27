-- Eventor sync snapshot (review package 5).
--
-- The last values an Eventor import or sync wrote (or saw) per runner and per
-- class. A re-sync applies an Eventor value only when Eventor changed it since
-- then AND the local value still equals what the sync last stored, so a desk
-- edit (rental card, class move, corrected name) survives. NULL = the row
-- predates the snapshot; the first sync after the upgrade seeds it and writes
-- nothing over a differing local value.
--
-- runners: { name, card_no, class_eventor_id, club_eventor_id, club_name,
--            birth_year, sex, nationality, present, synced_at }
-- classes: { name, sex, low_age, high_age, no_timing, sort_index, class_type }
--
-- Additive: an older image ignores both columns. docs/system/eventor-sync.md.

ALTER TABLE "oxygen"."runners" ADD COLUMN "eventor_snapshot" JSONB;
ALTER TABLE "oxygen"."classes" ADD COLUMN "eventor_snapshot" JSONB;
