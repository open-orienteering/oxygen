-- Per-peer journal-shipping watermarks (pivot Step 3). One row per
-- (peer, event). Cursors are (hlc, id) pairs — encoded HLCs can tie across
-- stations, so the entry id is the deterministic tie-break for pagination.
-- See docs/offline-architecture.md § "Journal shipping".

CREATE TABLE "oxygen"."journal_sync_state" (
  "peer_id"    TEXT   NOT NULL,
  "event_id"   BIGINT NOT NULL,
  "pushed_hlc" BIGINT NOT NULL DEFAULT 0,
  "pushed_id"  TEXT   NOT NULL DEFAULT '',
  "pulled_hlc" BIGINT NOT NULL DEFAULT 0,
  "pulled_id"  TEXT   NOT NULL DEFAULT '',
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "journal_sync_state_pkey" PRIMARY KEY ("peer_id", "event_id"),
  CONSTRAINT "journal_sync_state_event_id_fkey" FOREIGN KEY ("event_id")
    REFERENCES "oxygen"."events"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TRIGGER trg_journal_sync_state_updated_at BEFORE UPDATE ON oxygen.journal_sync_state
FOR EACH ROW EXECUTE FUNCTION oxygen.set_updated_at();
