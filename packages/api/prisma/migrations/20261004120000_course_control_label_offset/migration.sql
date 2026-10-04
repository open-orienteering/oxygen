-- Manual per-course control-number offsets (map millimetres from the
-- control centre). Null = auto-placed.
ALTER TABLE "oxygen"."course_controls"
  ADD COLUMN IF NOT EXISTS "label_dx" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "label_dy" DOUBLE PRECISION;
