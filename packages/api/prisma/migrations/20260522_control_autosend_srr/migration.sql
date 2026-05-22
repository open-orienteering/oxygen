-- Add AIR+ per-control autosend mode (writable today via upsertConfig,
-- previously dropped on the floor pending a column) and an SRR_CFG bit
-- per control_unit that captures whether the station has hardware
-- short-range radio enabled, used to drive the "SRR+" badge on the
-- Controls page.

ALTER TABLE oxygen.controls
  ADD COLUMN autosend_mode TEXT NOT NULL DEFAULT 'last';

ALTER TABLE oxygen.control_units
  ADD COLUMN srr_cfg BOOLEAN NOT NULL DEFAULT FALSE;
