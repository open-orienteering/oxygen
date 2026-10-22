/**
 * S0 corpus check (docs/research/vector-map-pipeline/09-migration.md §7,
 * 06 §9; docs/map-import.md §6–7): imports every map file in the given
 * directories through the same code path as the API's import worker
 * (`importMapToDocument` + `buildImportReport`, no decisions) and prints,
 * per map, the document hash, `format.importer`, library version, counts,
 * the warning-code histogram, matching outcomes and the stage-5
 * `georeference` / `north` report fields (docs/map-import.md §3.8).
 *
 *   node scripts/measure-import.mjs <dir|file>… [--previous <json>] [--out <json>] [--hashes <json>]
 *
 *   --previous  a JSON written by --out or --hashes (this or another machine);
 *               each map gets `sameAsPrevious`, matched by source file hash
 *               first and by file name second (to report a changed source)
 *   --out       write this run per file name (hashes, counts, histograms,
 *               stage-5 fields — WGS 84 origin and extent, so keep it in .local/)
 *   --hashes    write only the compact hash list, keyed by the source file's
 *               SHA-256 (`map_sources.file_hash`): `{ name, documentHash,
 *               importer, libraryVersion }` — no georeference, safe to move
 *               between machines and to compare with production
 *
 * Directories are read flat (no recursion) for `.ocd`, `.omap` and `.xmap`.
 * The corpus itself is never committed (AGENTS.md §12), and neither are the
 * JSON files this writes.
 *
 * Exit status: 0 when every map imported, none produced an
 * unsupported-primitive warning (class `unsupported` in `WARNING_CLASS`,
 * packages/shared/src/import/report.ts; docs/map-import.md §7) and, with
 * --previous, every document hash equals the previous run's; 1 otherwise;
 * 2 on usage errors.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

const MAP_EXT = /\.(ocd|omap|xmap)$/i;

function usage(message) {
  if (message) console.error(message);
  console.error("usage: node scripts/measure-import.mjs <dir|file>… [--previous <json>] [--out <json>] [--hashes <json>]");
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { paths: [], previous: null, out: null, hashes: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--previous" || a === "--out" || a === "--hashes") {
      const v = argv[++i];
      if (!v) usage(`${a} needs a file`);
      opts[a.slice(2)] = v;
    } else if (a.startsWith("--")) usage(`unknown option ${a}`);
    else opts.paths.push(a);
  }
  if (opts.paths.length === 0) usage();
  return opts;
}

function listMaps(paths) {
  const files = [];
  for (const p of paths) {
    let st;
    try {
      st = statSync(p);
    } catch {
      usage(`${p}: no such file or directory`);
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(p).sort()) {
        const f = join(p, name);
        if (MAP_EXT.test(name) && statSync(f).isFile()) files.push(f);
      }
    } else files.push(p);
  }
  const seen = new Map();
  for (const f of files) {
    const key = basename(f);
    if (seen.has(key)) usage(`two maps named ${key}: ${seen.get(key)} and ${f}`);
    seen.set(key, f);
  }
  return [...seen.entries()];
}

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const deg = (v, digits = 3) => (v == null ? "—" : `${v.toFixed(digits)}°`);
const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`;

/**
 * The warnings of one class (`classes` is `WARNING_CLASS`) with the report's per-emission detail (code, message, symbol index) behind
 * each code. `unsupported` fails the run; `source-error` is listed per symbol and does not.
 */
function classified(report, classes, wanted) {
  const details = report.warningDetails ?? [];
  return report.warnings
    .filter((w) => classes[w.code] === wanted)
    .map((w) => ({ ...w, details: details.filter((d) => d.code === w.code).map(({ message, symbolIdx }) => (symbolIdx === undefined ? { message } : { message, symbolIdx })) }));
}

function histogram(warnings) {
  const h = {};
  for (const w of warnings) h[w.code] = (h[w.code] ?? 0) + w.count;
  return Object.fromEntries(Object.entries(h).sort(([a], [b]) => a.localeCompare(b)));
}

/** Index a --previous file (either shape) by source file hash and by file name. */
function indexPrevious(json) {
  const byFile = new Map();
  const byName = new Map();
  for (const [key, v] of Object.entries(json.maps ?? {})) {
    const fileHash = v.fileHash ?? (/^[0-9a-f]{64}$/.test(key) ? key : undefined);
    const name = v.name ?? key;
    const entry = { ...v, fileHash, name };
    if (fileHash) byFile.set(fileHash, entry);
    byName.set(name, entry);
  }
  return (m) => byFile.get(m.fileHash) ?? byName.get(m.name);
}

/** Why a map's hash differs from the previous run, or null when it does not. */
function compare(map, prev) {
  if (!prev) return { sameAsPrevious: null, reason: "not in previous run" };
  if (prev.documentHash === map.documentHash) return { sameAsPrevious: true, reason: null };
  const changed = [];
  if (prev.fileHash !== map.fileHash) changed.push("source file differs");
  if (prev.importer !== map.importer) changed.push(`importer ${prev.importer} → ${map.importer}`);
  if (prev.libraryVersion !== map.libraryVersion) changed.push(`library ${prev.libraryVersion} → ${map.libraryVersion}`);
  return { sameAsPrevious: false, reason: changed.length ? changed.join(", ") : "same inputs, different bytes (determinism failure)" };
}

/** One line per code, then one indented line per emission the report details (`symbol N  message`). */
function printWarnings(marker, warnings) {
  for (const w of warnings) {
    console.log(`  ${marker} ${w.code} ×${w.count}: ${w.message ?? ""}`);
    for (const d of w.details) console.log(d.symbolIdx === undefined ? `    ${d.message}` : `    symbol ${d.symbolIdx}  ${d.message}`);
  }
}

function printMap(m) {
  console.log(`\n=== ${m.name}  (${m.kind}, ${mb(m.bytes)})`);
  if (m.error) {
    console.log(`  ERROR ${m.error}`);
    return;
  }
  const prev = m.sameAsPrevious == null ? `— (${m.reason})` : m.sameAsPrevious ? "yes" : `NO — ${m.reason}`;
  console.log(`  document   ${m.documentHash}`);
  console.log(`  source     ${m.fileHash}  ${m.kind} ${m.sourceVersion}`);
  console.log(`  importer   ${m.importer}   library ${m.libraryVersion}   sameAsPrevious ${prev}`);
  const c = m.counts;
  console.log(`  counts     objects ${c.objects}  coordinates ${c.coordinates}  symbols ${c.symbols} (rendered ${c.symbolsRendered}, unrendered ${c.symbolsUnrendered})  colours ${c.colours}  texts ${c.texts}  graphic ${c.graphicObjects}  missing-symbol objects ${c.missingSymbolObjects}`);
  const ms = m.matching.symbols;
  const mo = m.matching.objects;
  console.log(`  matching   symbols auto ${ms.auto} / suggested ${ms.suggested} / variant ${ms.variant} / none ${ms.unmatched} (reviewed ${ms.reviewed})`);
  console.log(`             objects auto ${mo.auto} / suggested ${mo.suggested} / variant ${mo.variant} / none ${mo.unmatched}`);
  console.log(`             ${m.matching.library} ${m.matching.edition}, factor ×${m.matching.factor} by ${m.matching.factorMethod}`);
  const hist = Object.entries(m.warnings);
  console.log(`  warnings   ${hist.length ? hist.map(([k, v]) => `${k} ${v}`).join(", ") : "none"}`);
  printWarnings("!", m.unsupported);
  printWarnings("~", m.sourceErrors);
  const g = m.georeference;
  if (g) {
    const o = g.originWgs84 ? `${g.originWgs84.lat.toFixed(5)}, ${g.originWgs84.lng.toFixed(5)}` : "—";
    const b = g.wgs84Bounds ? `N ${g.wgs84Bounds.north.toFixed(5)} S ${g.wgs84Bounds.south.toFixed(5)} E ${g.wgs84Bounds.east.toFixed(5)} W ${g.wgs84Bounds.west.toFixed(5)}` : "—";
    console.log(`  georef     crs ${g.crs ?? "—"}  method ${g.method}  projectable ${g.projectable}  grid rotation ${deg(g.gridRotationDeg)}  convergence ${deg(g.gridConvergenceDeg)}`);
    console.log(`             origin ${o}  bounds ${b}`);
  }
  const n = m.north;
  if (n) {
    const mer = n.meridian ? `${n.meridian.code} (symbol ${n.meridian.symbolIdx}) ×${n.meridian.count} tilt ${deg(n.meridian.medianTiltDeg)} sd ${deg(n.meridian.stddevDeg)}` : "none";
    console.log(`  north      meridian ${mer}`);
    console.log(`             paper-north bearing ${deg(n.paperNorthBearingDeg)}  display offset ${deg(n.displayNorthOffsetDeg)}  declared grivation ${deg(n.declaredGrivationDeg)}  true north from grid ${deg(n.trueNorthFromGridDeg)}`);
    console.log(`             declination ${deg(n.declinationDeg)}  meridian staleness ${deg(n.meridianStalenessDeg)}  as of ${n.asOf}`);
  }
  const t = m.timings;
  console.log(`  timings    read ${t.read.toFixed(0)} ms  normalise ${t.normalise.toFixed(0)} ms  match ${t.match.toFixed(0)} ms  encode ${t.encode.toFixed(0)} ms`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const maps = listMaps(opts.paths);
  if (maps.length === 0) usage(`no .ocd / .omap / .xmap files in ${opts.paths.join(", ")}`);
  const previous = opts.previous ? indexPrevious(JSON.parse(readFileSync(opts.previous, "utf8"))) : null;

  // The API's TypeScript sources, loaded as the worker loads them.
  register();
  const api = resolve(dirname(fileURLToPath(import.meta.url)), "..", "packages", "api", "src");
  const { importMapToDocument } = await import(join(api, "import", "ocad.ts"));
  const { buildImportReport } = await import(join(api, "map-store", "documents.ts"));
  const { sniffMapKind } = await import(join(api, "map-store", "uploads.ts"));
  const { mapDocument, mapImport } = await import(join(api, "..", "..", "shared", "src", "index.ts"));

  const results = [];
  for (const [name, path] of maps) {
    const file = readFileSync(path);
    const kind = sniffMapKind(file.subarray(0, 1024));
    const base = { name, kind: kind ?? "unknown", bytes: file.byteLength };
    let m;
    if (!kind) m = { ...base, error: "not an OCAD or Mapper file" };
    else {
      try {
        // As import-worker.ts: no club decisions on a first import.
        const result = await importMapToDocument(file, name, kind, { match: { decisions: [] } });
        const { header } = mapDocument.readMapDocumentHeader(result.bytes);
        const report = buildImportReport(result, header, name);
        m = {
          ...base,
          documentHash: result.documentHash,
          fileHash: result.fileHash,
          importer: header.format.importer,
          libraryVersion: result.libraryVersion,
          sourceVersion: header.source.version,
          counts: report.counts,
          warnings: histogram(report.warnings),
          unsupported: classified(report, mapImport.WARNING_CLASS, "unsupported"),
          sourceErrors: classified(report, mapImport.WARNING_CLASS, "source-error"),
          matching: {
            library: `${report.matching.library.id}@${report.matching.library.version}`,
            edition: report.matching.edition,
            factor: report.matching.factor.factor,
            factorMethod: report.matching.factor.method,
            symbols: report.matching.symbols,
            objects: report.matching.objects,
            byMethod: report.matching.byMethod,
          },
          georeference: report.georeference ?? null,
          north: report.north ?? null,
          timings: result.timings,
        };
      } catch (err) {
        m = { ...base, error: err instanceof Error ? err.stack ?? err.message : String(err) };
      }
    }
    if (!m.error && previous) Object.assign(m, compare(m, previous(m)));
    else if (!m.error) Object.assign(m, { sameAsPrevious: null, reason: "no --previous" });
    printMap(m);
    results.push(m);
  }

  const ok = results.filter((m) => !m.error);
  const errors = results.length - ok.length;
  const unsupported = ok.reduce((n, m) => n + m.unsupported.reduce((a, w) => a + w.count, 0), 0);
  const differ = ok.filter((m) => m.sameAsPrevious === false);
  const missing = ok.filter((m) => m.sameAsPrevious == null).length;
  const total = {};
  for (const m of ok) for (const [k, v] of Object.entries(m.warnings)) total[k] = (total[k] ?? 0) + v;

  console.log(`\n=== summary: ${results.length} maps`);
  console.log(`  warnings   ${Object.entries(total).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}  (${sum(total)} in all)`);
  console.log(`  import errors                    ${errors}  ${errors ? "FAIL" : "pass"}`);
  console.log(`  unsupported-primitive warnings   ${unsupported}  ${unsupported ? "FAIL" : "pass"}`);
  if (previous) console.log(`  sameAsPrevious                   ${ok.length - differ.length - missing}/${ok.length}${missing ? ` (${missing} not in previous run)` : ""}  ${differ.length ? "FAIL" : missing ? "incomplete" : "pass"}`);
  else console.log("  sameAsPrevious                   not checked (no --previous)");

  const hashes = {
    tool: "measure-import",
    keyedBy: "fileHash",
    maps: Object.fromEntries(ok.map((m) => [m.fileHash, { name: m.name, documentHash: m.documentHash, importer: m.importer, libraryVersion: m.libraryVersion }])),
  };
  console.log("\nhashes (file → document):");
  for (const [fileHash, h] of Object.entries(hashes.maps)) console.log(`  ${fileHash}  ${h.documentHash}  ${h.importer}  ${h.libraryVersion}  ${h.name}`);
  if (opts.hashes) writeFileSync(opts.hashes, JSON.stringify(hashes, null, 2) + "\n");
  if (opts.out) {
    const maps = Object.fromEntries(results.map(({ name, ...m }) => [name, m]));
    writeFileSync(opts.out, JSON.stringify({ tool: "measure-import", ranAt: new Date().toISOString(), node: process.version, maps }, null, 2) + "\n");
  }
  process.exit(errors || unsupported || differ.length ? 1 : 0);
}

await main();
