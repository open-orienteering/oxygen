-- Who has a course open (slice D, row D11; docs/course-layer.md §7 "Presence
-- and live refresh", docs/course-editor.md §11). Additive: a new table. One
-- row per open editor (a tab's random client id), upserted by the heartbeat
-- `course.presence`; a row older than the 30 s TTL is not shown and is swept
-- by the next heartbeat. Not journaled: presence is volatile, never shipped.
CREATE TABLE IF NOT EXISTS "oxygen"."course_presence" (
  "course_id" UUID NOT NULL,
  "client_id" TEXT NOT NULL,
  "event_id"  BIGINT NOT NULL,
  "user_id"   UUID,
  "name"      TEXT NOT NULL DEFAULT '',
  "mode"      TEXT NOT NULL,
  "seen_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "course_presence_pkey" PRIMARY KEY ("course_id", "client_id"),
  CONSTRAINT "course_presence_course_id_fkey" FOREIGN KEY ("course_id")
    REFERENCES "oxygen"."courses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "course_presence_event_id_fkey" FOREIGN KEY ("event_id")
    REFERENCES "oxygen"."events"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "course_presence_event_id_seen_at_idx"
  ON "oxygen"."course_presence"("event_id", "seen_at");
