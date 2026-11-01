-- Course objects (slice D, row D2; docs/course-layer.md §8 "Course
-- objects"; research 08 §4.5, §4.8). Purple / white objects stored per
-- event with a scope, drawn by the course layer on screen and in print.
-- Cloud-owned, not journaled; they travel in the checkout snapshot and the
-- per-event dump. Additive: a new table an older image never reads.
CREATE TABLE "oxygen"."course_objects" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "event_id" BIGINT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL,
    -- Paper mm, y-up: the layout path's vertex / Bézier shape.
    "geometry" JSONB NOT NULL,
    "props" JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- { "all": true } | { "courses": [uuid], "classes": [uuid] }; no FK
    -- (JSONB): a removed course or class simply matches nothing.
    "scope" JSONB NOT NULL,
    -- Draw order among the event's objects (courseObject.reorder).
    "z" INTEGER NOT NULL DEFAULT 0,
    -- Optimistic-concurrency token (course-layer.md §7): an HLC minted on
    -- every write; objects have no journal entry to take it from.
    "version" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "course_objects_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "course_objects_event_id_fkey"
      FOREIGN KEY ("event_id") REFERENCES "oxygen"."events"("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "course_objects_kind_check"
      CHECK ("kind" IN ('oob_area', 'oob_line', 'whiteout', 'toner_saver', 'marked_route',
                        'text', 'image', 'filter_region', 'inset_frame'))
);

CREATE UNIQUE INDEX "course_objects_event_id_seq_key"
  ON "oxygen"."course_objects"("event_id", "seq");
CREATE INDEX "course_objects_event_id_z_seq_idx"
  ON "oxygen"."course_objects"("event_id", "z", "seq");

CREATE TRIGGER trg_course_objects_seq
  BEFORE INSERT ON "oxygen"."course_objects"
  FOR EACH ROW EXECUTE FUNCTION "oxygen"."allocate_event_seq"();
CREATE TRIGGER trg_course_objects_updated_at
  BEFORE UPDATE ON "oxygen"."course_objects"
  FOR EACH ROW EXECUTE FUNCTION "oxygen"."set_updated_at"();
