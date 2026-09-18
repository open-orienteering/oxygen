CREATE TABLE "oxygen"."graphics" (
    "id" BIGSERIAL NOT NULL,
    "event_id" BIGINT,
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "graphics_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "graphics_event_id_fkey"
      FOREIGN KEY ("event_id") REFERENCES "oxygen"."events"("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "graphics_mime_check"
      CHECK ("mime" IN ('image/svg+xml', 'image/png'))
);

CREATE INDEX "graphics_event_id_idx" ON "oxygen"."graphics"("event_id");

CREATE TRIGGER trg_graphics_updated_at
  BEFORE UPDATE ON "oxygen"."graphics"
  FOR EACH ROW EXECUTE FUNCTION "oxygen"."set_updated_at"();
