ALTER TABLE oxygen.events
  ADD COLUMN kind_custom TEXT NOT NULL DEFAULT '';

-- Existing Eventor-linked events inherit their cached classification once.
-- Later local edits to kind are authoritative and are never overwritten.
UPDATE oxygen.events AS e
SET kind = CASE m.classification_id
  WHEN 1 THEN 'championship'
  WHEN 2 THEN 'national'
  WHEN 3 THEN 'district'
  WHEN 4 THEN 'local'
  WHEN 5 THEN 'club'
  WHEN 6 THEN 'international'
  ELSE e.kind
END
FROM oxygen.eventor_event_meta AS m
WHERE e.eventor_event_id = m.eventor_event_id
  AND e.kind = 'competition'
  AND m.classification_id BETWEEN 1 AND 6;
