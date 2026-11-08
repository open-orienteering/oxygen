-- F12, the consolidation (docs/course-layer.md §3.6 "Migration (F12)";
-- docs/migrations/2026-f12-map-anchored-objects.md).
--
-- Every map-anchored layout object (`anchor: "map"`) of a template
-- (`map_templates.objects`) or a sheet (`course_maps.objects`) becomes a
-- `course_objects` row: the kind by fill mode and shape, the geometry
-- copied (both are paper mm, y-up), a text's size divided by the sheet's
-- overprint enlargement (`mapScale / printScale`, which the retired layer
-- branch divided by) so it prints the same size, `source = 'layout'`. The
-- scope: a template's objects `{ all }`; a course sheet's that course; a
-- class sheet's that class; an all-controls sheet's, and a setter sheet's
-- without a course, `{ all }`. The rows then keep their page-anchored
-- objects only; a club template's map-anchored objects (never drawn: the
-- import has always stripped them) are removed from its payload.
--
-- DATA-REWRITING. Prisma runs the file in one transaction, so a failed
-- guard leaves everything as it was. The rollback after a commit is the
-- database backup taken immediately before; the previous image also runs
-- on the migrated data (it draws course objects and page-anchored ones).
--
-- The guard. An object with no course-object kind is refused, never
-- dropped: a solid fill, a stroke that is not the template's purple on a
-- line or an unfilled shape, a stroke on a white-out, an area of fewer than
-- three vertices, a text without a size or one that would exceed the course
-- object's 100 mm once divided by the enlargement, an unknown kind or fill
-- mode. The exception names each
-- one (event, table, row seq, object id, reason); the runbook says how to
-- fix them. A soft-deleted event (`events.removed`) is not guarded: its
-- unmappable objects are removed with the move (E5's precedent). Objects
-- that draw nothing (no fill and no stroke, an empty text) are removed and
-- counted.
--
-- Idempotent: a second run finds no map-anchored object and changes
-- nothing; the constraint is dropped and re-added.

-- ─── Where a course object came from: 'layout' marks the moved ones ─────

ALTER TABLE "oxygen"."course_objects" DROP CONSTRAINT IF EXISTS "course_objects_source_check";
ALTER TABLE "oxygen"."course_objects"
  ADD CONSTRAINT "course_objects_source_check" CHECK ("source" IS NULL OR "source" IN ('import', 'layout'));

-- ─── The mapping ────────────────────────────────────────────────────────

-- The legacy kinds `unify_map_fill_modes` folded, should one remain.
CREATE FUNCTION "oxygen"."f12_norm"(o jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN o->>'kind' = 'whiteoutRect' THEN (o - 'kind') || '{"kind": "rectangle", "fillMode": "whiteout"}'::jsonb
    WHEN o->>'kind' = 'whiteoutPolygon' THEN (o - 'kind') || '{"kind": "path", "fillMode": "whiteout", "closed": true}'::jsonb
    ELSE o
  END
$$;

-- The course-object kind of one map-anchored object, 'invisible' (draws
-- nothing) or 'reject:<reason>'. Mirrors the retired layer branch: a
-- stroke needs both `stroke` and `strokeWidthMm`, a 709 area's stroke is
-- its 709.b / 709.c boundary (colour and width were never read). A body
-- the API would not read back (`courseObjectBodySchema`) is refused, so no
-- moved row can vanish from the lists.
CREATE FUNCTION "oxygen"."f12_class"(raw jsonb, purple text, os double precision) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  o jsonb := "oxygen"."f12_norm"(raw);
  k text := o->>'kind';
  fill text := coalesce(o->>'fillMode', 'none');
  stroked boolean := (o ? 'stroke') AND (o ? 'strokeWidthMm');
  is_purple boolean := coalesce(lower(o->>'stroke') IN (lower(coalesce(purple, '#a626ff')), '#a626ff'), false);
  dashed boolean := coalesce(o->>'dash' = 'dashed', false);
  n integer;
BEGIN
  IF k = 'image' THEN
    RETURN CASE WHEN o ? 'graphicId' AND o ? 'width' AND o ? 'height' THEN 'image' ELSE 'reject:image_without_graphic' END;
  END IF;
  IF k = 'text' THEN
    IF coalesce(o->>'text', '') = '' THEN RETURN 'invisible'; END IF;
    IF jsonb_typeof(o->'fontSizeMm') IS DISTINCT FROM 'number' OR (o->>'fontSizeMm')::double precision <= 0
       OR jsonb_typeof(o->'x') IS DISTINCT FROM 'number' OR jsonb_typeof(o->'y') IS DISTINCT FROM 'number'
       OR coalesce(o->>'color', '') !~* '^#[0-9a-f]{6}$' THEN
      RETURN 'reject:malformed_text';
    END IF;
    IF (o->>'fontSizeMm')::double precision / os > 100 THEN RETURN 'reject:text_too_large'; END IF;
    RETURN 'text';
  END IF;
  IF k = 'line' THEN
    IF NOT stroked THEN RETURN 'invisible'; END IF;
    IF NOT is_purple THEN RETURN 'reject:coloured_line'; END IF;
    RETURN CASE WHEN dashed THEN 'marked_route' ELSE 'oob_line' END;
  END IF;
  IF k IS NULL OR k NOT IN ('rectangle', 'path') THEN RETURN 'reject:unknown_kind'; END IF;
  n := CASE WHEN k = 'rectangle' THEN 4
            WHEN jsonb_typeof(o->'points') = 'array' THEN jsonb_array_length(o->'points')
            ELSE 0 END;
  IF fill = 'solid' AND o ? 'fill' THEN RETURN 'reject:solid_fill'; END IF;
  IF fill IN ('whiteout', 'whiteoutInverted', 'outOfBounds') THEN
    IF n < 3 THEN RETURN 'reject:degenerate_area'; END IF;
    IF fill <> 'outOfBounds' AND stroked THEN RETURN 'reject:stroked_whiteout'; END IF;
    RETURN CASE fill WHEN 'whiteout' THEN 'whiteout' WHEN 'whiteoutInverted' THEN 'toner_saver' ELSE 'oob_area' END;
  END IF;
  IF fill NOT IN ('none', 'solid') THEN RETURN 'reject:unknown_fill'; END IF;
  -- `none`, or `solid` without a fill colour: the stroke alone.
  IF n < 2 THEN RETURN 'reject:degenerate_line'; END IF;
  IF NOT stroked THEN RETURN 'invisible'; END IF;
  IF NOT is_purple THEN RETURN 'reject:coloured_stroke'; END IF;
  RETURN CASE WHEN dashed THEN 'marked_route' ELSE 'oob_line' END;
END
$$;

-- The course object's body `{ kind, geometry, props }` (course-layer.md
-- §8.1), or NULL for an invisible or refused object. `os` = the sheet's
-- `mapScale / printScale`.
CREATE FUNCTION "oxygen"."f12_body"(raw jsonb, os double precision, purple text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  o jsonb := "oxygen"."f12_norm"(raw);
  c text := "oxygen"."f12_class"(raw, purple, os);
  k text := o->>'kind';
  x double precision;
  y double precision;
  g jsonb;
BEGIN
  IF c = 'invisible' OR c LIKE 'reject:%' THEN RETURN NULL; END IF;
  IF k IN ('rectangle', 'image') THEN
    x := (o->>'x')::double precision;
    y := (o->>'y')::double precision;
  END IF;

  IF c = 'text' THEN
    RETURN jsonb_build_object(
      'kind', 'text',
      'geometry', jsonb_build_array(jsonb_build_object('x', o->'x', 'y', o->'y')),
      'props', jsonb_strip_nulls(jsonb_build_object(
        'text', o->'text',
        'fontSizeMm', to_jsonb((o->>'fontSizeMm')::double precision / os),
        'fontFamily', o->'fontFamily',
        'color', o->'color',
        'align', o->'align')));
  END IF;
  IF c = 'image' THEN
    RETURN jsonb_build_object(
      'kind', 'image',
      'geometry', jsonb_build_array(
        jsonb_build_object('x', o->'x', 'y', o->'y'),
        jsonb_build_object('x', to_jsonb(x + (o->>'width')::double precision), 'y', to_jsonb(y + (o->>'height')::double precision))),
      'props', jsonb_strip_nulls(jsonb_build_object('graphicId', o->'graphicId', 'crop', o->'crop')));
  END IF;

  g := CASE k
    WHEN 'line' THEN jsonb_build_array(jsonb_build_object('x', o->'x1', 'y', o->'y1'), jsonb_build_object('x', o->'x2', 'y', o->'y2'))
    WHEN 'rectangle' THEN jsonb_build_array(
      jsonb_build_object('x', o->'x', 'y', o->'y'),
      jsonb_build_object('x', to_jsonb(x + (o->>'width')::double precision), 'y', o->'y'),
      jsonb_build_object('x', to_jsonb(x + (o->>'width')::double precision), 'y', to_jsonb(y + (o->>'height')::double precision)),
      jsonb_build_object('x', o->'x', 'y', to_jsonb(y + (o->>'height')::double precision)))
    ELSE o->'points'
  END;

  IF c IN ('oob_line', 'marked_route') THEN
    -- A closed outline as a line: back to its first vertex (a curved closing segment keeps its handles).
    IF k = 'rectangle' OR (k = 'path' AND coalesce((o->>'closed')::boolean, false)) THEN
      g := g || jsonb_build_array(g->0);
    END IF;
    RETURN jsonb_build_object('kind', c, 'geometry', g, 'props', '{}'::jsonb);
  END IF;
  IF c = 'oob_area' THEN
    RETURN jsonb_build_object('kind', 'oob_area', 'geometry', g, 'props',
      CASE WHEN NOT ((o ? 'stroke') AND (o ? 'strokeWidthMm')) THEN '{}'::jsonb
           WHEN o->>'dash' = 'dashed' THEN '{"border": "dashed"}'::jsonb
           ELSE '{"border": "solid"}'::jsonb END);
  END IF;
  -- whiteout, toner_saver
  RETURN jsonb_build_object('kind', c, 'geometry', g, 'props', '{}'::jsonb);
END
$$;

-- ─── Every map-anchored object, with its row's context ──────────────────

CREATE TEMPORARY TABLE "f12_objects" AS
WITH doc AS (
  -- The event's base map scale: its latest map file's document (getBaseMapInfo).
  SELECT DISTINCT ON (mf."event_id") mf."event_id", (md."header"->>'mapScale')::double precision AS map_scale
    FROM "oxygen"."map_files" mf
    LEFT JOIN "oxygen"."map_documents" md ON md."hash" = mf."document_hash"
   ORDER BY mf."event_id", mf."uploaded_at" DESC
),
src AS (
  SELECT 0 AS src_order, 'map_templates'::text AS tbl, t."id" AS row_id, t."event_id", t."seq" AS row_seq, t."objects",
         coalesce(t."settings"->'appearance'->>'purple', '#a626ff') AS purple,
         t."print_scale"::double precision AS print_scale,
         '{"all": true}'::jsonb AS scope
    FROM "oxygen"."map_templates" t
  UNION ALL
  SELECT 1, 'course_maps', m."id", m."event_id", m."seq", m."objects",
         coalesce(t."settings"->'appearance'->>'purple', '#a626ff'),
         coalesce((m."overrides"->>'printScale')::double precision, t."print_scale"::double precision),
         CASE WHEN m."kind" = 'all_controls' THEN '{"all": true}'::jsonb
              WHEN m."class_id" IS NOT NULL THEN jsonb_build_object('courses', '[]'::jsonb, 'classes', jsonb_build_array(m."class_id"))
              WHEN m."course_id" IS NOT NULL THEN jsonb_build_object('courses', jsonb_build_array(m."course_id"), 'classes', '[]'::jsonb)
              ELSE '{"all": true}'::jsonb END
    FROM "oxygen"."course_maps" m
    LEFT JOIN "oxygen"."map_templates" t ON t."id" = m."template_id"
)
SELECT s."src_order", s."tbl", s."row_id", s."event_id", s."row_seq", s."scope", e."removed",
       a."obj", a."ord",
       "oxygen"."f12_class"(a."obj", s."purple", os.v) AS class,
       "oxygen"."f12_body"(a."obj", os.v, s."purple") AS body
  FROM src s
  JOIN "oxygen"."events" e ON e."id" = s."event_id"
  LEFT JOIN doc d ON d."event_id" = s."event_id"
  CROSS JOIN LATERAL (SELECT CASE WHEN d."map_scale" > 0 AND s."print_scale" > 0 THEN d."map_scale" / s."print_scale" ELSE 1 END AS v) os
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s."objects") = 'array' THEN s."objects" ELSE '[]'::jsonb END)
    WITH ORDINALITY AS a("obj", "ord")
 WHERE a."obj"->>'anchor' = 'map';

-- ─── The guard ──────────────────────────────────────────────────────────

DO $$
DECLARE
  refused BIGINT;
  reasons TEXT;
  listing TEXT;
BEGIN
  SELECT count(*) INTO refused FROM "f12_objects" WHERE class LIKE 'reject:%' AND NOT removed;
  IF refused > 0 THEN
    SELECT string_agg(format('%s × %s', n, reason), ', ' ORDER BY reason) INTO reasons
      FROM (SELECT substr(class, 8) AS reason, count(*) AS n FROM "f12_objects"
             WHERE class LIKE 'reject:%' AND NOT removed GROUP BY 1) r;
    -- The first 200; the runbook's listing query has them all.
    SELECT string_agg(line, E'\n' ORDER BY k) INTO listing
      FROM (SELECT format('event %s %s seq %s object %s: %s', event_id, tbl, row_seq, obj->>'id', substr(class, 8)) AS line,
                   row_number() OVER (ORDER BY event_id, src_order, row_seq, ord) AS k
              FROM "f12_objects" WHERE class LIKE 'reject:%' AND NOT removed) l
     WHERE k <= 200;
    RAISE EXCEPTION 'F12 guard: % map-anchored layout object(s) of live events have no course-object kind (%); nothing was changed. Fix them as docs/migrations/2026-f12-map-anchored-objects.md says, then retry', refused, reasons
      USING DETAIL = listing;
  END IF;
END
$$;

-- ─── The move ───────────────────────────────────────────────────────────

-- Drawn under the event's existing course objects, as the layer drew
-- layout objects before course objects; templates, then sheets, each in
-- row and array order (the seq trigger numbers them in that order).
INSERT INTO "oxygen"."course_objects" ("event_id", "kind", "geometry", "props", "scope", "z", "version", "source")
SELECT f."event_id", f."body"->>'kind', f."body"->'geometry', f."body"->'props', f."scope",
       coalesce((SELECT min(co."z") FROM "oxygen"."course_objects" co WHERE co."event_id" = f."event_id"), 1) - 1,
       0, 'layout'
  FROM "f12_objects" f
 WHERE f."body" IS NOT NULL
 ORDER BY f."event_id", f."src_order", f."row_seq", f."ord";

-- The rows keep their page-anchored objects, in order.
CREATE FUNCTION "oxygen"."f12_page_only"(objects jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_agg(e ORDER BY i), '[]'::jsonb)
    FROM jsonb_array_elements(objects) WITH ORDINALITY AS a(e, i)
   WHERE e->>'anchor' IS DISTINCT FROM 'map'
$$;

UPDATE "oxygen"."map_templates" SET "objects" = "oxygen"."f12_page_only"("objects")
 WHERE "id" IN (SELECT "row_id" FROM "f12_objects" WHERE "tbl" = 'map_templates');
UPDATE "oxygen"."course_maps" SET "objects" = "oxygen"."f12_page_only"("objects")
 WHERE "id" IN (SELECT "row_id" FROM "f12_objects" WHERE "tbl" = 'course_maps');
UPDATE "oxygen"."club_map_templates" SET "payload" = jsonb_set("payload", '{objects}', "oxygen"."f12_page_only"("payload"->'objects'))
 WHERE jsonb_typeof("payload"->'objects') = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements("payload"->'objects') e WHERE e->>'anchor' = 'map');

DO $$
DECLARE
  moved BIGINT;
  invisible BIGINT;
  dropped BIGINT;
BEGIN
  SELECT count(*) FILTER (WHERE body IS NOT NULL),
         count(*) FILTER (WHERE class = 'invisible'),
         count(*) FILTER (WHERE class LIKE 'reject:%')
    INTO moved, invisible, dropped FROM "f12_objects";
  RAISE NOTICE 'F12: % map-anchored object(s) moved to course_objects, % invisible removed, % of soft-deleted events removed', moved, invisible, dropped;
END
$$;

DROP TABLE "f12_objects";
DROP FUNCTION "oxygen"."f12_page_only"(jsonb);
DROP FUNCTION "oxygen"."f12_body"(jsonb, double precision, text);
DROP FUNCTION "oxygen"."f12_class"(jsonb, text, double precision);
DROP FUNCTION "oxygen"."f12_norm"(jsonb);
