-- Snap legacy template map frames to the print margin so the base map
-- touches the red printable area the same way layout objects do.
-- Older templates used an 8 mm frame with a 3 mm margin (5 mm white gap).

UPDATE oxygen.map_templates AS t
SET settings = jsonb_set(
  jsonb_set(
    t.settings,
    '{printMarginMm}',
    to_jsonb(COALESCE((t.settings->>'printMarginMm')::double precision, 3.0)),
    true
  ),
  '{mapFrame}',
  jsonb_build_object(
    'x', m.margin,
    'y', m.margin,
    'width', GREATEST(0.001, m.paper_w - 2 * m.margin),
    'height', GREATEST(0.001, m.paper_h - 2 * m.margin)
  ),
  true
)
FROM (
  SELECT
    id,
    COALESCE((settings->>'printMarginMm')::double precision, 3.0) AS margin,
    CASE
      WHEN paper = 'A3' AND orientation = 'landscape' THEN 420
      WHEN paper = 'A3' THEN 297
      WHEN paper = 'A5' AND orientation = 'landscape' THEN 210
      WHEN paper = 'A5' THEN 148
      WHEN paper = 'custom' THEN COALESCE(paper_width_mm, 210)
      WHEN orientation = 'landscape' THEN 297
      ELSE 210
    END AS paper_w,
    CASE
      WHEN paper = 'A3' AND orientation = 'landscape' THEN 297
      WHEN paper = 'A3' THEN 420
      WHEN paper = 'A5' AND orientation = 'landscape' THEN 148
      WHEN paper = 'A5' THEN 210
      WHEN paper = 'custom' THEN COALESCE(paper_height_mm, 297)
      WHEN orientation = 'landscape' THEN 210
      ELSE 297
    END AS paper_h
  FROM oxygen.map_templates
) AS m
WHERE t.id = m.id;

UPDATE oxygen.club_map_templates AS c
SET payload = jsonb_set(
  jsonb_set(
    c.payload,
    '{settings,printMarginMm}',
    to_jsonb(COALESCE((c.payload->'settings'->>'printMarginMm')::double precision, 3.0)),
    true
  ),
  '{settings,mapFrame}',
  jsonb_build_object(
    'x', m.margin,
    'y', m.margin,
    'width', GREATEST(0.001, m.paper_w - 2 * m.margin),
    'height', GREATEST(0.001, m.paper_h - 2 * m.margin)
  ),
  true
)
FROM (
  SELECT
    id,
    COALESCE((payload->'settings'->>'printMarginMm')::double precision, 3.0) AS margin,
    CASE
      WHEN payload->>'paper' = 'A3' AND payload->>'orientation' = 'landscape' THEN 420
      WHEN payload->>'paper' = 'A3' THEN 297
      WHEN payload->>'paper' = 'A5' AND payload->>'orientation' = 'landscape' THEN 210
      WHEN payload->>'paper' = 'A5' THEN 148
      WHEN payload->>'paper' = 'custom' THEN COALESCE((payload->>'paperWidthMm')::double precision, 210)
      WHEN payload->>'orientation' = 'landscape' THEN 297
      ELSE 210
    END AS paper_w,
    CASE
      WHEN payload->>'paper' = 'A3' AND payload->>'orientation' = 'landscape' THEN 297
      WHEN payload->>'paper' = 'A3' THEN 420
      WHEN payload->>'paper' = 'A5' AND payload->>'orientation' = 'landscape' THEN 148
      WHEN payload->>'paper' = 'A5' THEN 210
      WHEN payload->>'paper' = 'custom' THEN COALESCE((payload->>'paperHeightMm')::double precision, 297)
      WHEN payload->>'orientation' = 'landscape' THEN 210
      ELSE 297
    END AS paper_h
  FROM oxygen.club_map_templates
  WHERE payload ? 'settings'
) AS m
WHERE c.id = m.id;
