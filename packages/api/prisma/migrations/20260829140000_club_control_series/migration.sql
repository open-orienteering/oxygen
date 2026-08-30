-- Club control inventory: prioritized series of punch codes (own + borrowed).

CREATE TYPE "oxygen"."club_control_type" AS ENUM ('normal', 'srr');

CREATE TABLE "oxygen"."club_control_series" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "owner_name" TEXT NOT NULL DEFAULT '',
    "borrowed" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "club_control_series_pkey" PRIMARY KEY ("id")
);

CREATE TRIGGER trg_club_control_series_updated_at BEFORE UPDATE ON oxygen.club_control_series
  FOR EACH ROW EXECUTE FUNCTION oxygen.set_updated_at();

CREATE TABLE "oxygen"."club_series_controls" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "series_id" UUID NOT NULL,
    "code" INTEGER NOT NULL,
    "type" "oxygen"."club_control_type" NOT NULL DEFAULT 'normal',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "club_series_controls_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "club_series_controls_series_id_code_key"
  ON "oxygen"."club_series_controls"("series_id", "code");

ALTER TABLE "oxygen"."club_series_controls"
  ADD CONSTRAINT "club_series_controls_series_id_fkey"
  FOREIGN KEY ("series_id") REFERENCES "oxygen"."club_control_series"("id") ON DELETE CASCADE ON UPDATE CASCADE;
