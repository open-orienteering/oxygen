/**
 * Corpus parity (docs/map-rendering.md §6.4; SLICES B9, the B-gate's
 * parity instrument): renders a paper window of an OCAD map through the
 * legacy tile path (`ocad2geojson` SVG via resvg) and through the
 * document path (importer → bridge → symbolise → reference raster), one
 * symbol at a time, and ranks the symbols by how much their shapes
 * differ. Writes `<code>.old.png`, `<code>.new.png`, `<code>.diff.png` per
 * compared symbol and `summary.md` into the output directory.
 *
 *   node scripts/measure-parity.mjs <map.ocd> [--window=x0,y0,x1,y1] [--px-per-mm=10]
 *        [--source] [--codes=510.0,511.2] [--out=<dir>]
 *
 *   --window     paper mm, y-up (the document frame: OCAD coordinates / 100);
 *                default the whole map
 *   --px-per-mm  whole px/mm, default 10 (the golden density)
 *   --source     draw every symbol from its source definition (canonical
 *                rendering off): renderer and importer against the legacy
 *   --codes      only these source codes
 *   --out        default .local/parity/<map>/ (corpus output is never committed,
 *                AGENTS.md §12)
 *
 * Exit status: 0 when every diverging symbol carries a sanctioned
 * difference (the B-gate criterion — still read its images), 1 when one
 * diverges without any, 2 on usage errors.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage(message) {
  if (message) console.error(message);
  console.error("usage: node scripts/measure-parity.mjs <map.ocd> [--window=x0,y0,x1,y1] [--px-per-mm=10] [--source] [--codes=a,b] [--out=<dir>]");
  process.exit(2);
}

export function parseArgs(argv) {
  const opts = { file: null, window: undefined, pxPerMm: 10, canonical: true, codes: undefined, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = () => inline ?? argv[++i];
    if (flag === "--window") {
      const v = String(value()).split(",").map(Number);
      if (v.length !== 4 || v.some((n) => !Number.isFinite(n)) || v[2] <= v[0] || v[3] <= v[1]) return { error: "--window wants x0,y0,x1,y1 in mm with x1 > x0, y1 > y0" };
      opts.window = { minX: v[0], minY: v[1], maxX: v[2], maxY: v[3] };
    } else if (flag === "--px-per-mm") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1 || n > 100) return { error: "--px-per-mm wants a whole number 1–100" };
      opts.pxPerMm = n;
    } else if (flag === "--source") opts.canonical = false;
    else if (flag === "--codes") opts.codes = String(value()).split(",").filter(Boolean);
    else if (flag === "--out") opts.out = value();
    else if (a.startsWith("--")) return { error: `unknown option ${a}` };
    else if (opts.file) return { error: "one map at a time" };
    else opts.file = a;
  }
  if (!opts.file) return { error: "no map given" };
  return { value: opts };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) usage(parsed.error);
  const opts = parsed.value;
  const name = basename(opts.file);
  const out = resolve(opts.out ?? join(root, ".local", "parity", name.replace(/\.[^.]+$/, "")));

  // The API's TypeScript sources, loaded as the import worker loads them.
  register();
  const api = join(root, "packages", "api", "src");
  const { runParity, parityMarkdown, rowFileStem } = await import(join(api, "render", "parity.ts"));
  const { encodePng } = await import(join(api, "render", "reference-raster.ts"));

  const t0 = performance.now();
  const report = await runParity(readFileSync(opts.file), name, {
    window: opts.window, pxPerMm: opts.pxPerMm, canonical: opts.canonical, codes: opts.codes, keepImages: true,
  });
  mkdirSync(out, { recursive: true });
  for (const row of report.rows) {
    if (!row.images) continue;
    for (const k of ["old", "new", "diff"]) writeFileSync(join(out, `${rowFileStem(row)}.${k}.png`), await encodePng(row.images[k]));
  }
  writeFileSync(join(out, "summary.md"), parityMarkdown(report));

  const compared = report.rows.filter((r) => r.diff);
  const diverging = compared.filter((r) => r.verdict === "diverges");
  console.log(`${name}: ${compared.length} symbols compared in ${report.window.minX},${report.window.minY} – ${report.window.maxX},${report.window.maxY} mm at ${report.pxPerMm} px/mm (${report.canonical ? "canonical" : "source"}), ${diverging.length} diverge`);
  for (const r of diverging.slice(0, 20)) {
    console.log(`  ${r.code.padEnd(8)} ${(r.diff.unexplainedRatio * 100).toFixed(2).padStart(6)} %  ${r.name}${r.sanctioned.length ? `  [${r.sanctioned.join(", ")}]` : ""}`);
  }
  console.log(`wrote ${out}/summary.md (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  process.exit(diverging.some((r) => r.sanctioned.length === 0) ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
