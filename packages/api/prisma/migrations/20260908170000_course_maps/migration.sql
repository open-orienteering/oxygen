CREATE TABLE "oxygen"."map_templates" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "event_id" BIGINT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL,
    "paper" TEXT NOT NULL DEFAULT 'A4',
    "paper_width_mm" DOUBLE PRECISION,
    "paper_height_mm" DOUBLE PRECISION,
    "orientation" TEXT NOT NULL DEFAULT 'portrait',
    "print_scale" INTEGER NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "objects" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "map_templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "map_templates_event_id_fkey"
      FOREIGN KEY ("event_id") REFERENCES "oxygen"."events"("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "map_templates_paper_check"
      CHECK ("paper" IN ('A3', 'A4', 'A5', 'custom')),
    CONSTRAINT "map_templates_orientation_check"
      CHECK ("orientation" IN ('portrait', 'landscape')),
    CONSTRAINT "map_templates_print_scale_check" CHECK ("print_scale" > 0),
    CONSTRAINT "map_templates_custom_paper_check"
      CHECK (
        "paper" <> 'custom'
        OR (
          "paper_width_mm" IS NOT NULL AND "paper_width_mm" > 0
          AND "paper_height_mm" IS NOT NULL AND "paper_height_mm" > 0
        )
      )
);

CREATE UNIQUE INDEX "map_templates_event_id_seq_key"
  ON "oxygen"."map_templates"("event_id", "seq");
CREATE UNIQUE INDEX "map_templates_event_id_name_key"
  ON "oxygen"."map_templates"("event_id", "name");

CREATE TRIGGER trg_map_templates_seq
  BEFORE INSERT ON "oxygen"."map_templates"
  FOR EACH ROW EXECUTE FUNCTION "oxygen"."allocate_event_seq"();
CREATE TRIGGER trg_map_templates_updated_at
  BEFORE UPDATE ON "oxygen"."map_templates"
  FOR EACH ROW EXECUTE FUNCTION "oxygen"."set_updated_at"();

CREATE TABLE "oxygen"."course_maps" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "event_id" BIGINT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'course',
    "course_id" UUID,
    "template_id" UUID,
    "window_center" JSONB,
    "overrides" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "objects" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "course_maps_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "course_maps_event_id_fkey"
      FOREIGN KEY ("event_id") REFERENCES "oxygen"."events"("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "course_maps_course_id_fkey"
      FOREIGN KEY ("course_id") REFERENCES "oxygen"."courses"("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "course_maps_template_id_fkey"
      FOREIGN KEY ("template_id") REFERENCES "oxygen"."map_templates"("id")
      ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "course_maps_kind_check"
      CHECK ("kind" IN ('course', 'all_controls')),
    CONSTRAINT "course_maps_course_kind_check"
      CHECK (
        ("kind" = 'course' AND "course_id" IS NOT NULL)
        OR ("kind" = 'all_controls' AND "course_id" IS NULL)
      )
);

CREATE UNIQUE INDEX "course_maps_event_id_seq_key"
  ON "oxygen"."course_maps"("event_id", "seq");
CREATE INDEX "course_maps_event_id_course_id_sort_order_idx"
  ON "oxygen"."course_maps"("event_id", "course_id", "sort_order");
CREATE INDEX "course_maps_template_id_idx"
  ON "oxygen"."course_maps"("template_id");
CREATE UNIQUE INDEX "course_maps_one_all_controls_per_event"
  ON "oxygen"."course_maps"("event_id")
  WHERE "kind" = 'all_controls';

CREATE TRIGGER trg_course_maps_seq
  BEFORE INSERT ON "oxygen"."course_maps"
  FOR EACH ROW EXECUTE FUNCTION "oxygen"."allocate_event_seq"();
CREATE TRIGGER trg_course_maps_updated_at
  BEFORE UPDATE ON "oxygen"."course_maps"
  FOR EACH ROW EXECUTE FUNCTION "oxygen"."set_updated_at"();

CREATE TABLE "oxygen"."club_map_templates" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "uploaded_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "club_map_templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "club_map_templates_uploaded_by_fkey"
      FOREIGN KEY ("uploaded_by") REFERENCES "oxygen"."users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "club_map_templates_name_key"
  ON "oxygen"."club_map_templates"("name");
CREATE TRIGGER trg_club_map_templates_updated_at
  BEFORE UPDATE ON "oxygen"."club_map_templates"
  FOR EACH ROW EXECUTE FUNCTION "oxygen"."set_updated_at"();
