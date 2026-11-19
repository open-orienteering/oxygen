-- J13 (user answer 11; docs/course-layer.md §6.4 "J13 reset", §10.2): a corridor's white band was stored with a
-- `whiteOpacity` but drawn opaque until J13. From J13 a value below 1 draws translucent, so every stored value below 1
-- is reset to 1 and old maps print as before. Data only: `courses.structure` (top-level legs and legs inside a
-- variation's alternatives, walked recursively); every other key is kept, a second run changes nothing. Journal
-- payloads, snapshots and dumps are not rewritten (§6.4).
CREATE FUNCTION "oxygen"."j13_reset_corridor_opacity"(j JSONB) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  k TEXT;
  v JSONB;
  out JSONB;
BEGIN
  IF jsonb_typeof(j) = 'array' THEN
    SELECT COALESCE(jsonb_agg("oxygen"."j13_reset_corridor_opacity"(e) ORDER BY i), '[]'::jsonb) INTO out
      FROM jsonb_array_elements(j) WITH ORDINALITY AS t(e, i);
    RETURN out;
  ELSIF jsonb_typeof(j) = 'object' THEN
    out := '{}'::jsonb;
    FOR k, v IN SELECT * FROM jsonb_each(j) LOOP
      IF k = 'corridor' AND jsonb_typeof(v) = 'object' AND jsonb_typeof(v->'whiteOpacity') = 'number' AND (v->>'whiteOpacity')::numeric < 1 THEN
        out := out || jsonb_build_object(k, v || '{"whiteOpacity": 1}'::jsonb);
      ELSE
        out := out || jsonb_build_object(k, "oxygen"."j13_reset_corridor_opacity"(v));
      END IF;
    END LOOP;
    RETURN out;
  END IF;
  RETURN j;
END;
$$;

UPDATE "oxygen"."courses"
SET "structure" = "oxygen"."j13_reset_corridor_opacity"("structure")
WHERE "structure" IS NOT NULL
  AND jsonb_path_exists("structure", '$.**.corridor.whiteOpacity ? (@ < 1)');

DROP FUNCTION "oxygen"."j13_reset_corridor_opacity"(JSONB);
