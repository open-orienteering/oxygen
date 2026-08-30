-- Per-event permission grants + kiosk device key.

ALTER TABLE "oxygen"."events" ADD COLUMN "kiosk_key" TEXT;

CREATE TABLE "oxygen"."permission_groups" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "capabilities" JSONB NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "permission_groups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "permission_groups_name_key" ON "oxygen"."permission_groups"("name");

CREATE TRIGGER trg_permission_groups_updated_at BEFORE UPDATE ON oxygen.permission_groups
  FOR EACH ROW EXECUTE FUNCTION oxygen.set_updated_at();

CREATE TABLE "oxygen"."event_permissions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "event_id" BIGINT NOT NULL,
    "user_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "granted_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "event_permissions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "event_permissions_event_id_user_id_group_id_key"
  ON "oxygen"."event_permissions"("event_id", "user_id", "group_id");
CREATE INDEX "event_permissions_event_id_user_id_idx"
  ON "oxygen"."event_permissions"("event_id", "user_id");

ALTER TABLE "oxygen"."event_permissions"
  ADD CONSTRAINT "event_permissions_event_id_fkey"
  FOREIGN KEY ("event_id") REFERENCES "oxygen"."events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "oxygen"."event_permissions"
  ADD CONSTRAINT "event_permissions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "oxygen"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "oxygen"."event_permissions"
  ADD CONSTRAINT "event_permissions_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "oxygen"."permission_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "oxygen"."event_permissions"
  ADD CONSTRAINT "event_permissions_granted_by_fkey"
  FOREIGN KEY ("granted_by") REFERENCES "oxygen"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "oxygen"."permission_groups" ("id", "name", "capabilities", "is_system") VALUES
  ('01990e00-0000-7000-8000-000000000001', 'Event admin',
   '["event.view","event.manage","courses.view","courses.edit","race.operate","results.view"]'::jsonb, true),
  ('01990e00-0000-7000-8000-000000000002', 'Course setter',
   '["event.view","courses.view","courses.edit"]'::jsonb, true),
  ('01990e00-0000-7000-8000-000000000003', 'Race crew',
   '["event.view","race.operate","results.view"]'::jsonb, true),
  ('01990e00-0000-7000-8000-000000000004', 'Member',
   '["event.view","results.view"]'::jsonb, true);
