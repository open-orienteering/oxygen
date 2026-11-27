-- Leg routes (docs/course-elevation.md §7): a route between two controls
-- of an event in the direction it is run, shared by every course that
-- runs the pair. `points`: interior vertices in paper mm; the ends are
-- the controls and follow them. At most one row of a pair is chosen —
-- the one the pair's climb is read along.
-- Additive: a new table an older image never reads. Not journaled.
CREATE TABLE "oxygen"."leg_routes" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "event_id" BIGINT NOT NULL,
    "from_control_id" UUID NOT NULL,
    "to_control_id" UUID NOT NULL,
    "points" JSONB NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'drawn',
    "model" TEXT,
    "chosen" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leg_routes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "leg_routes_source_check" CHECK ("source" IN ('drawn', 'computed')),
    CONSTRAINT "leg_routes_pair_check" CHECK ("from_control_id" <> "to_control_id")
);

CREATE INDEX "leg_routes_event_id_from_control_id_to_control_id_idx" ON "oxygen"."leg_routes"("event_id", "from_control_id", "to_control_id");
CREATE UNIQUE INDEX "leg_routes_chosen_pair_key" ON "oxygen"."leg_routes"("event_id", "from_control_id", "to_control_id") WHERE "chosen";

ALTER TABLE "oxygen"."leg_routes" ADD CONSTRAINT "leg_routes_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "oxygen"."events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "oxygen"."leg_routes" ADD CONSTRAINT "leg_routes_from_control_id_fkey" FOREIGN KEY ("from_control_id") REFERENCES "oxygen"."controls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "oxygen"."leg_routes" ADD CONSTRAINT "leg_routes_to_control_id_fkey" FOREIGN KEY ("to_control_id") REFERENCES "oxygen"."controls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
