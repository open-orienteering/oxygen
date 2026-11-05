-- Who wrote a control's description (slice D, row D6; docs/course-layer.md
-- §6.3, §9). 'auto': an autodetect path filled it (control.create /
-- control.update with autoDescribe); 'manual': a write carried an explicit
-- description — a manual edit equal to the autodetect result is still
-- 'manual'. NULL: no description, or a row written before D6 (unknown,
-- never stale). The DESCRIPTION_STALE check reads it.
-- Additive: a nullable column an older image never reads. It travels in
-- `control.upserted` with the other portable fields; a peer applying such
-- an entry needs this migration, as with D0's site columns.
ALTER TABLE "oxygen"."controls" ADD COLUMN "description_source" TEXT;
ALTER TABLE "oxygen"."controls"
  ADD CONSTRAINT "controls_description_source_check" CHECK ("description_source" IS NULL OR "description_source" IN ('auto', 'manual'));
