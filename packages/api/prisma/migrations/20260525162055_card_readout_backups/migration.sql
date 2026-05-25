-- CreateTable
CREATE TABLE "oxygen"."card_readout_backups" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "event_id" BIGINT NOT NULL,
    "station_serial" INTEGER,
    "slot_address" INTEGER NOT NULL,
    "card_no" INTEGER NOT NULL,
    "card_type" TEXT NOT NULL DEFAULT '',
    "punches" JSONB NOT NULL,
    "start_time" INTEGER,
    "finish_time" INTEGER,
    "check_time" INTEGER,
    "clear_time" INTEGER,
    "original_read_at" TIMESTAMPTZ(6),
    "owner_data" JSONB,
    "punches_hash" TEXT NOT NULL,
    "imported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pushed_at" TIMESTAMPTZ(6),
    "pushed_readout_id" UUID,
    "raw_bytes" BYTEA,

    CONSTRAINT "card_readout_backups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "card_readout_backups_event_id_card_no_idx" ON "oxygen"."card_readout_backups"("event_id", "card_no");

-- CreateIndex
CREATE INDEX "card_readout_backups_event_id_pushed_at_idx" ON "oxygen"."card_readout_backups"("event_id", "pushed_at");

-- CreateIndex
CREATE UNIQUE INDEX "card_readout_backups_event_id_punches_hash_key" ON "oxygen"."card_readout_backups"("event_id", "punches_hash");

-- AddForeignKey
ALTER TABLE "oxygen"."card_readout_backups" ADD CONSTRAINT "card_readout_backups_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "oxygen"."events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
