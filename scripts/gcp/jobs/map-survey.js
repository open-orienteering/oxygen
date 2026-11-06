// Slice E preflight survey (docs/release-slice-e.md §0): read-only.
// Every number under "must be zero" has to be zero before the flip (E3).
const { Client } = require(require.resolve("pg", { paths: [process.cwd()] }));
const u = new URL(process.env.DATABASE_URL);
u.searchParams.delete("schema");
const c = new Client({ connectionString: u.toString() });
const q = async (label, sql) => {
  try { const r = await c.query(sql); console.log(label + " " + JSON.stringify(r.rows)); }
  catch (e) { console.log(label + " ERR " + e.message); }
};
const LATEST = `LEFT JOIN LATERAL (SELECT * FROM oxygen.map_files m WHERE m.event_id = e.id ORDER BY uploaded_at DESC, id DESC LIMIT 1) lm ON true`;
(async () => {
  await c.connect();
  await q("settings", "SELECT key, value FROM oxygen.settings WHERE key LIKE 'map.%' ORDER BY key");
  await q("events", `SELECT e.map_pipeline AS p, count(*)::int AS events,
      count(*) FILTER (WHERE lm.id IS NULL)::int AS no_map,
      count(*) FILTER (WHERE lm.id IS NOT NULL AND lm.document_hash IS NULL)::int AS map_no_doc,
      count(*) FILTER (WHERE lm.document_hash IS NOT NULL)::int AS pinned
    FROM oxygen.events e ${LATEST} WHERE NOT e.removed GROUP BY 1`);
  console.log("── must be zero");
  await q("unpinned_events", `SELECT e.id::text, e.name_id, e.name, e.map_pipeline AS p, lm.id::text AS map_file, lm.file_name, lm.source_hash IS NOT NULL AS sourced,
      (SELECT json_agg(json_build_object('state', j.state, 'error', left(j.error, 300), 'at', j.updated_at) ORDER BY j.created_at DESC)
         FROM oxygen.map_import_jobs j WHERE j.event_id = e.id) AS jobs
    FROM oxygen.events e ${LATEST} WHERE NOT e.removed AND lm.id IS NOT NULL AND lm.document_hash IS NULL`);
  await q("map_files_unsourced", "SELECT count(*)::int AS n FROM oxygen.map_files m JOIN oxygen.events e ON e.id = m.event_id WHERE NOT e.removed AND m.source_hash IS NULL");
  await q("club_files_unmigrated", "SELECT count(*)::int AS n FROM oxygen.club_map_files WHERE club_map_id IS NULL");
  // The E5 (v0.6.1) migration's guard also needs each club row's bytes in map_sources.
  await q("club_files_bytes_unsourced", `SELECT count(*)::int AS n FROM oxygen.club_map_files f WHERE NOT EXISTS (
      SELECT 1 FROM oxygen.map_sources s WHERE s.file_hash = coalesce(f.file_hash, encode(sha256(f.file_data), 'hex')))`);
  await q("courses_no_structure", `SELECT e.name_id, c.name, c.geometry_source FROM oxygen.courses c JOIN oxygen.events e ON e.id = c.event_id
    WHERE NOT c.removed AND NOT e.removed AND c.structure IS NULL ORDER BY 1, 2`);
  await q("stack_unaligned", `SELECT DISTINCT e.name_id, lm.document_hash FROM oxygen.events e ${LATEST}
    JOIN oxygen.map_documents d ON d.hash = lm.document_hash
    WHERE NOT (d.header -> 'colours') @> '[{"paletteIds":["purple-upper"]}]'
       OR NOT (d.header -> 'colours') @> '[{"paletteIds":["purple-lower"]}]'`);
  await q("header_has_colours", `SELECT count(*) FILTER (WHERE header ? 'colours')::int AS with_colours, count(*)::int AS docs FROM oxygen.map_documents`);
  console.log("── information");
  await q("removed_events_unsourced_maps", `SELECT e.name_id, count(*)::int AS map_files FROM oxygen.map_files m JOIN oxygen.events e ON e.id = m.event_id
    WHERE e.removed AND m.source_hash IS NULL GROUP BY 1`);
  await q("events_no_map", `SELECT e.name_id, e.name, e.map_pipeline AS p FROM oxygen.events e ${LATEST} WHERE NOT e.removed AND lm.id IS NULL`);
  await q("jobs", "SELECT state, count(*)::int AS n FROM oxygen.map_import_jobs GROUP BY 1");
  await q("failed_jobs_latest", `SELECT DISTINCT ON (coalesce(event_id::text, club_map_id::text)) event_id::text, club_map_id::text, left(error, 300) AS error, updated_at
    FROM oxygen.map_import_jobs WHERE state = 'failed' ORDER BY coalesce(event_id::text, club_map_id::text), created_at DESC`);
  await q("sizes", `SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS size FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'oxygen' AND relname IN ('map_tiles','rendered_maps','map_files','club_map_files','map_sources','map_documents') ORDER BY 1`);
  await c.end();
})().catch((err) => { console.error(err); process.exit(1); });
