/**
 * Corpus print run (docs/course-print.md §11; SLICES C7, the slice's
 * regression net, 09 §8): prints one course page of an OCAD map on its
 * OCAD print window through the route's composer (`renderCoursePages`) in
 * `rgb` and `cmyk`, runs `qpdf --check`, rasterises with `pdftocairo` and
 * compares (a) with the page oracle — backend parity: the same shapes (B9's
 * unexplained pixels ≤ 0.01 % of ink) and ≤ 0.5 % of the pixels beyond 32
 * levels, the 16-level ratio and a text-as-outlines run reported — and
 * (b) with the legacy rsvg page of the same sheet, classified by the
 * sanctioned differences (§8.4) and per symbol by B9's parity tool.
 * Records size and time per page and compares with the previous run.
 * Writes the PDFs, the rasters and diff images, `summary.md` and
 * `summary.json` into the output directory; the previous `summary.json`
 * is kept as `summary.previous.json`.
 *
 *   node scripts/measure-print.mjs <map.ocd> [--paper=A4[:landscape]] [--print-scale=N]
 *        [--centre=x,y] [--px-per-mm=10] [--no-legacy] [--no-symbols] [--out=<dir>]
 *
 *   --paper        ISO paper (A3 | A4 | A5, optional :portrait / :landscape) instead of
 *                  the print window's own size; frame = paper − 3 mm margins
 *   --print-scale  print scale denominator (default the print window's, else the map's)
 *   --centre       window centre, paper mm y-up (default the print window's centre)
 *   --px-per-mm    whole px/mm of the comparison rasters, default 10 (the golden density)
 *   --no-legacy    skip the legacy rsvg page
 *   --no-symbols   skip the per-symbol parity of the window
 *   --out          default .local/print/<map>/ (corpus output is never committed,
 *                  AGENTS.md §12; the PDFs carry the map's georeferencing)
 *
 * Tools: `pdftocairo` (poppler-utils) is required; `qpdf` and
 * `rsvg-convert` (librsvg2-bin) are used when on the PATH and their part
 * is skipped otherwise. A machine without the packages can put wrappers
 * on the PATH that run them from an image which has them, e.g.
 *   exec docker run --rm -i -u "$(id -u):$(id -g)" -v /tmp:/tmp -v "$HOME:$HOME" -w "$PWD" \
 *     ${FONTCONFIG_FILE:+-e FONTCONFIG_FILE=$FONTCONFIG_FILE} --entrypoint rsvg-convert oxygen-api:latest "$@"
 * (the api image has rsvg-convert; qpdf likewise from any image with the
 * `qpdf` package). The legacy page's fonts are pinned through
 * FONTCONFIG_FILE to the bundled Liberation files, so pass it through.
 *
 * One map per invocation: Club-full is 36 MB and the per-symbol parity
 * imports it again.
 *
 * Exit status: 0 when the page composed, `qpdf` found no errors, both modes
 * are within the backend-parity budgets, both pages have the sheet's size and
 * every diverging symbol carries a sanctioned difference; 1 otherwise (a map
 * that does not compose or print included); 2 on usage errors.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage(message) {
  if (message) console.error(message);
  console.error(
    "usage: node scripts/measure-print.mjs <map.ocd> [--paper=A4[:landscape]] [--print-scale=N] [--centre=x,y] [--px-per-mm=10] [--no-legacy] [--no-symbols] [--out=<dir>]",
  );
  process.exit(2);
}

export function parseArgs(argv) {
  const opts = { file: null, paper: undefined, printScale: undefined, centre: undefined, pxPerMm: 10, legacy: true, symbols: true, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = () => inline ?? argv[++i];
    if (flag === "--paper") {
      const m = /^(A3|A4|A5)(?::(portrait|landscape))?$/i.exec(String(value()));
      if (!m) return { error: "--paper wants A3, A4 or A5, optionally :portrait or :landscape" };
      opts.paper = { size: m[1].toUpperCase(), ...(m[2] ? { orientation: m[2].toLowerCase() } : {}) };
    } else if (flag === "--print-scale") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 100 || n > 100_000) return { error: "--print-scale wants a whole denominator 100–100000" };
      opts.printScale = n;
    } else if (flag === "--centre") {
      const v = String(value()).split(",").map(Number);
      if (v.length !== 2 || v.some((n) => !Number.isFinite(n))) return { error: "--centre wants x,y in paper mm" };
      opts.centre = { x: v[0], y: v[1] };
    } else if (flag === "--px-per-mm") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1 || n > 40) return { error: "--px-per-mm wants a whole number 1–40" };
      opts.pxPerMm = n;
    } else if (flag === "--no-legacy") opts.legacy = false;
    else if (flag === "--no-symbols") opts.symbols = false;
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
  const out = resolve(opts.out ?? join(root, ".local", "print", name.replace(/\.[^.]+$/, "")));

  // The API's TypeScript sources, loaded as the import worker loads them.
  register();
  const api = join(root, "packages", "api", "src");
  const { runPrint, printMarkdown } = await import(join(api, "render", "print-run.ts"));
  const { rowFileStem } = await import(join(api, "render", "parity.ts"));
  const { encodePng } = await import(join(api, "render", "reference-raster.ts"));

  const t0 = performance.now();
  mkdirSync(out, { recursive: true });
  const summaryJson = join(out, "summary.json");
  const previous = existsSync(summaryJson) ? JSON.parse(readFileSync(summaryJson, "utf8")) : null;
  const report = await runPrint(readFileSync(opts.file), name, {
    paper: opts.paper,
    printScale: opts.printScale,
    centre: opts.centre,
    pxPerMm: opts.pxPerMm,
    legacy: opts.legacy,
    symbols: opts.symbols,
    previous,
    onPdf: (file, bytes) => writeFileSync(join(out, file), bytes),
    onImage: async (file, img) => writeFileSync(join(out, file), await encodePng(img)),
    onSymbolImages: async (row, images) => {
      for (const k of ["old", "new", "diff"]) writeFileSync(join(out, `symbol.${rowFileStem(row)}.${k}.png`), await encodePng(images[k]));
    },
  });
  if (previous) renameSync(summaryJson, join(out, "summary.previous.json"));
  writeFileSync(summaryJson, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(out, "summary.md"), printMarkdown(report));

  const pct = (x, d = 3) => `${(x * 100).toFixed(d)} %`;
  const kb = (b) => `${(b / 1024).toFixed(0)} kB`;
  console.log(
    `${name}: ${report.paper.name} at 1:${report.printScale} (${report.source}), ${report.objects} objects, compose ${report.composeMs} ms`,
  );
  for (const m of ["rgb", "cmyk"]) {
    const x = report.modes[m];
    console.log(`  ${m.padEnd(4)} ${kb(x.bytes).padStart(8)}  ${String(x.renderMs).padStart(6)} ms  qpdf ${x.qpdf}  parity ${pct(x.strong.ratio)} > 32 levels, ${pct(x.parity.ratio)} > 16 (outlines ${pct(x.outline.ratio)}), unexplained ${pct(x.shape.ratio, 4)} of ink`);
  }
  if ("skipped" in report.legacy) console.log(`  legacy skipped: ${report.legacy.skipped}`);
  else console.log(`  legacy unexplained ${pct(report.legacy.unexplainedRatio, 2)} of ink, differing ${pct(report.legacy.inkRatio, 2)}`);
  if ("skipped" in report.symbols) console.log(`  symbols skipped: ${report.symbols.skipped}`);
  else console.log(`  symbols: ${report.symbols.compared} compared, ${report.symbols.diverging.length} diverge, ${report.symbols.unsanctioned} unsanctioned`);
  if (report.previous) {
    console.log(`  previous run: same bytes rgb ${report.previous.sameBytes.rgb}, cmyk ${report.previous.sameBytes.cmyk}`);
  }
  console.log(`${report.pass ? "PASS" : "FAIL"}${report.failures.length ? ": " + report.failures.join("; ") : ""}`);
  console.log(`wrote ${out}/summary.md (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  process.exit(report.pass ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1); // a map that does not print fails the run
  });
}
