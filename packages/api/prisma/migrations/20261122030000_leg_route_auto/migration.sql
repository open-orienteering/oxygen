-- Automatic leg routes and the course's winner pace (docs/course-elevation.md §7.5).
-- `leg_routes.auto_basis`: non-NULL marks the pair's automatic route — the
-- shortest legal one, written by the server — and names what it was
-- searched on; NULL is a person's route. At most one automatic row per pair.
-- `courses.winner_pace_s_per_km`: the expected winner pace, seconds per km.
-- Additive: an older image reads an automatic row as any chosen route and
-- never reads the pace.
ALTER TABLE "oxygen"."leg_routes" ADD COLUMN "auto_basis" TEXT;
CREATE UNIQUE INDEX "leg_routes_auto_pair_key" ON "oxygen"."leg_routes"("event_id", "from_control_id", "to_control_id") WHERE "auto_basis" IS NOT NULL;

ALTER TABLE "oxygen"."courses" ADD COLUMN "winner_pace_s_per_km" INTEGER;
