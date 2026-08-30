-- Club-defined user groups. A grant's subject becomes either a single
-- user or a club group (whose membership is resolved at capability-check
-- time, so member changes apply immediately to every granted event).

CREATE TABLE "oxygen"."club_user_groups" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "club_user_groups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "club_user_groups_name_key" ON "oxygen"."club_user_groups"("name");

CREATE TABLE "oxygen"."club_user_group_members" (
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "club_user_group_members_pkey" PRIMARY KEY ("group_id","user_id")
);

CREATE INDEX "club_user_group_members_user_id_idx" ON "oxygen"."club_user_group_members"("user_id");

ALTER TABLE "oxygen"."club_user_group_members"
  ADD CONSTRAINT "club_user_group_members_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "oxygen"."club_user_groups"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "oxygen"."club_user_group_members"
  ADD CONSTRAINT "club_user_group_members_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "oxygen"."users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- event_permissions: subject is now user XOR club group.
ALTER TABLE "oxygen"."event_permissions" ALTER COLUMN "user_id" DROP NOT NULL;

ALTER TABLE "oxygen"."event_permissions" ADD COLUMN "club_group_id" UUID;

ALTER TABLE "oxygen"."event_permissions"
  ADD CONSTRAINT "event_permissions_club_group_id_fkey"
  FOREIGN KEY ("club_group_id") REFERENCES "oxygen"."club_user_groups"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "oxygen"."event_permissions"
  ADD CONSTRAINT "event_permissions_subject_check"
  CHECK (("user_id" IS NULL) <> ("club_group_id" IS NULL));

CREATE UNIQUE INDEX "event_permissions_event_id_club_group_id_group_id_key"
  ON "oxygen"."event_permissions"("event_id", "club_group_id", "group_id");

CREATE INDEX "event_permissions_event_id_club_group_id_idx"
  ON "oxygen"."event_permissions"("event_id", "club_group_id");
