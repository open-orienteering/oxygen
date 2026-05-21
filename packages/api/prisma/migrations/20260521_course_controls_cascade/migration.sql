-- Allow event teardown to cascade through course_controls.
-- The original FK used ON DELETE RESTRICT to "protect" a course from
-- losing a leg when the underlying control is deleted, but in practice
-- control deletion is always soft (`removed = true`) and never issues
-- a raw DELETE — so the RESTRICT only ever fires when an event itself
-- is being torn down, where it's actively in the way. Switch to
-- CASCADE so `DELETE FROM oxygen.events WHERE id = ?` works without
-- needing per-table cleanup orchestration in tests / migration tools.
ALTER TABLE oxygen.course_controls
  DROP CONSTRAINT course_controls_control_id_fkey,
  ADD CONSTRAINT course_controls_control_id_fkey
    FOREIGN KEY (control_id)
    REFERENCES oxygen.controls(id)
    ON DELETE CASCADE;
