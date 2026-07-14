-- Per-event single-writer lease (pivot Step 4). One row per checkout; the
-- active lease is the row with released_at IS NULL. The partial unique index
-- makes double-checkout a constraint violation, not a race.
-- See docs/offline-architecture.md § "The lease".

CREATE TABLE "oxygen"."event_lease" (
  "id"             BIGSERIAL PRIMARY KEY,
  "event_id"       BIGINT NOT NULL,
  "holder_node_id" TEXT NOT NULL,
  "acquired_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "released_at"    TIMESTAMPTZ(6),
  "forced"         BOOLEAN NOT NULL DEFAULT false,

  CONSTRAINT "event_lease_event_id_fkey" FOREIGN KEY ("event_id")
    REFERENCES "oxygen"."events"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "event_lease_event_id_released_at_idx"
  ON "oxygen"."event_lease"("event_id", "released_at");

-- At most one active lease per event.
CREATE UNIQUE INDEX "event_lease_one_active_per_event"
  ON "oxygen"."event_lease"("event_id")
  WHERE "released_at" IS NULL;
