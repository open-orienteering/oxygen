CREATE TABLE "oxygen"."club_class_presets" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "sex" TEXT NOT NULL DEFAULT '',
    "low_age" INTEGER NOT NULL DEFAULT 0,
    "high_age" INTEGER NOT NULL DEFAULT 0,
    "class_type" TEXT NOT NULL DEFAULT '',
    "no_timing" BOOLEAN NOT NULL DEFAULT false,
    "free_start" BOOLEAN NOT NULL DEFAULT false,
    "allow_quick_entry" BOOLEAN NOT NULL DEFAULT false,
    "sort_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "club_class_presets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "club_class_presets_sex_check" CHECK ("sex" IN ('', 'M', 'F'))
);

CREATE UNIQUE INDEX "club_class_presets_name_key"
  ON "oxygen"."club_class_presets"("name");

CREATE TRIGGER trg_club_class_presets_updated_at
  BEFORE UPDATE ON "oxygen"."club_class_presets"
  FOR EACH ROW EXECUTE FUNCTION "oxygen"."set_updated_at"();
