// F12 preflight (docs/migrations/2026-f12-map-anchored-objects.md §2): read-only.
// Counts the map-anchored layout objects the migration moves, then — on an
// image that carries the F12 migration (`--tag` of the release) — runs the
// migration itself inside a transaction that is always rolled back: its guard
// either passes (the NOTICE says what it would move) or refuses and lists each
// object it cannot map. Nothing is written either way.
const { readFileSync, existsSync } = require("node:fs");
const { Client } = require(require.resolve("pg", { paths: [process.cwd()] }));
const MIGRATION = "prisma/migrations/20261109120000_map_anchored_objects_to_course_objects/migration.sql";
const u = new URL(process.env.DATABASE_URL);
u.searchParams.delete("schema");
const c = new Client({ connectionString: u.toString() });
const q = async (label, sql) => {
  try { const r = await c.query(sql); console.log(label + " " + JSON.stringify(r.rows)); }
  catch (e) { console.log(label + " ERR " + e.message); }
};
const OBJECTS = (table) => `SELECT '${table}' AS tbl, t.event_id, e.name_id, e.removed, t.seq, x.obj
    FROM oxygen.${table} t JOIN oxygen.events e ON e.id = t.event_id,
         jsonb_array_elements(CASE WHEN jsonb_typeof(t.objects) = 'array' THEN t.objects ELSE '[]'::jsonb END) x(obj)
   WHERE x.obj->>'anchor' = 'map'`;
(async () => {
  await c.connect();
  c.on("notice", (n) => console.log("notice " + n.message));
  console.log("── what moves (live and soft-deleted events)");
  await q("map_anchored", `WITH o AS (${OBJECTS("map_templates")} UNION ALL ${OBJECTS("course_maps")})
    SELECT tbl, removed, obj->>'kind' AS kind, coalesce(obj->>'fillMode', 'none') AS fill, lower(obj->>'stroke') AS stroke,
           obj->>'dash' AS dash, (obj ? 'fill') AS has_fill, count(*)::int AS n
      FROM o GROUP BY 1, 2, 3, 4, 5, 6, 7 ORDER BY 1, 2, 3, 4, 5, 6, 7`);
  await q("map_anchored_by_event", `WITH o AS (${OBJECTS("map_templates")} UNION ALL ${OBJECTS("course_maps")})
    SELECT name_id, removed, tbl, count(*)::int AS n FROM o GROUP BY 1, 2, 3 ORDER BY 1, 3`);
  await q("club_payload_map_anchored", `SELECT c.name, count(*)::int AS n FROM oxygen.club_map_templates c,
      jsonb_array_elements(CASE WHEN jsonb_typeof(c.payload->'objects') = 'array' THEN c.payload->'objects' ELSE '[]'::jsonb END) x(obj)
     WHERE x.obj->>'anchor' = 'map' GROUP BY 1 ORDER BY 1`);
  await q("course_objects_layout_already", "SELECT count(*)::int AS n FROM oxygen.course_objects WHERE source = 'layout'");
  if (!existsSync(MIGRATION)) {
    console.log("── dry run skipped: this image has no F12 migration (run with --tag of the release that carries it)");
  } else {
    console.log("── dry run (rolled back)");
    await c.query("BEGIN");
    try {
      await c.query(readFileSync(MIGRATION, "utf8"));
      console.log("dry_run OK: the guard passes");
    } catch (e) {
      console.log("dry_run REFUSED " + e.message);
      if (e.detail) for (const line of String(e.detail).split("\n")) console.log("  " + line);
    } finally {
      await c.query("ROLLBACK");
    }
  }
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
