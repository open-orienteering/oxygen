-- Fold legacy whiteoutRect / whiteoutPolygon object kinds into rectangle /
-- path with fillMode = 'whiteout'. The Zod preprocess in courseMapObjectSchema
-- still accepts the old kinds; this migration makes stored JSON match the
-- canonical shape.

CREATE OR REPLACE FUNCTION oxygen.normalize_map_object(obj jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN obj->>'kind' = 'whiteoutRect' THEN
      (obj - 'kind') || jsonb_build_object('kind', 'rectangle', 'fillMode', 'whiteout')
    WHEN obj->>'kind' = 'whiteoutPolygon' THEN
      (obj - 'kind') || jsonb_build_object('kind', 'path', 'fillMode', 'whiteout', 'closed', true)
    ELSE obj
  END;
$$;

CREATE OR REPLACE FUNCTION oxygen.normalize_map_objects(arr jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
    (
      SELECT jsonb_agg(oxygen.normalize_map_object(elem) ORDER BY ordinality)
      FROM jsonb_array_elements(COALESCE(arr, '[]'::jsonb)) WITH ORDINALITY AS t(elem, ordinality)
    ),
    '[]'::jsonb
  );
$$;

UPDATE oxygen.map_templates
SET objects = oxygen.normalize_map_objects(objects)
WHERE objects::text LIKE '%whiteout%';

UPDATE oxygen.course_maps
SET objects = oxygen.normalize_map_objects(objects)
WHERE objects::text LIKE '%whiteout%';

UPDATE oxygen.club_map_templates
SET payload = jsonb_set(
  payload,
  '{objects}',
  oxygen.normalize_map_objects(payload->'objects')
)
WHERE payload->'objects' IS NOT NULL
  AND (payload->'objects')::text LIKE '%whiteout%';

DROP FUNCTION oxygen.normalize_map_objects(jsonb);
DROP FUNCTION oxygen.normalize_map_object(jsonb);
