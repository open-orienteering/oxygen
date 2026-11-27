-- Restore the event_seqs section of a per-event dump (docs/ops/backup-restore.md)
-- into the event `event_id`. Merges with GREATEST: restoring the other sections
-- first makes the allocate_event_seq() trigger create counters at MAX(seq)+1,
-- so a plain \copy would hit the primary key. A counter may be ahead of the
-- rows (deleted rows keep their numbers); the merge keeps the higher of the
-- dump's and the one the trigger made, and never lowers one. Idempotent.
--
--   cd <dir with the dump split into <table>.csv files>
--   psql "$DATABASE_URL" -v event_id=<new id> -f <repo>/packages/api/scripts/restore-event-seqs.sql
--
-- Reads event_seqs.csv (the lines after `--- event_seqs ---`, header row included).

\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE restore_event_seqs (LIKE oxygen.event_seqs) ON COMMIT DROP;
\copy restore_event_seqs FROM 'event_seqs.csv' WITH (FORMAT csv, HEADER true)

INSERT INTO oxygen.event_seqs (event_id, table_name, next_seq)
SELECT :event_id, r.table_name, r.next_seq FROM restore_event_seqs r
ON CONFLICT (event_id, table_name)
DO UPDATE SET next_seq = GREATEST(oxygen.event_seqs.next_seq, EXCLUDED.next_seq);

COMMIT;
