-- Course-level special-instruction / finish rows for the IOF description sheet.
ALTER TABLE "oxygen"."courses"
  ADD COLUMN IF NOT EXISTS "description_instructions" JSONB;
