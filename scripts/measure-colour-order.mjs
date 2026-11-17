/**
 * Colour-order parity (docs/map-rendering.md §6.5; SLICES I1): draws every
 * given map with the reference raster in two colour orders — the
 * document's stack as the importer built it (the *source*) and a
 * *candidate* — and names every pixel that changes by the two layers on
 * top, one in each order ("black50-building → brown30-paved"). The oracle
 * of slice I's canonical colour layers (`map-symbols.md` §9.3), as B9 and
 * C7 were for theirs.
 *
 *   node scripts/measure-colour-order.mjs <file|dir>… [--maps <tsv>] [--out <dir>]
 *        [--classes <json>] [--candidate permutation] [--tile-mm 60] [--px-per-mm 6]
 *        [--tolerance 16] [--worst 3] [--worst-px-per-mm 12] [--window x0,y0,x1,y1]
 *
 *   --maps        a list file: one map per line, `<label>\t<path>` (or a bare
 *                 path, labelled by its file name); blank lines and `#` comments
 *                 are skipped
 *   --out         where to write; must lie under a `.local/colour-order/`
 *                 directory (default `<repo>/.local/colour-order/`): per map
 *                 `<label>/summary.json`, `tiles.json`, `classes.suggested.json`
 *                 and `worst-<n>-tile-<x>-<y>.png` (source | candidate |
 *                 difference), and `run.json` for the run
 *   --classes     the classification file (§6.5): `{ version: 1, rules: [{ map?,
 *                 from, to, class, note? }] }`, first match wins
 *   --candidate   the candidate order; `permutation` (the 2026-11-14
 *                 experiment's) is the only one until I3
 *   --tolerance   a pixel changes when a channel differs by more (§6.2's 16;
 *                 the experiment used 24)
 *   --window      paper mm, y-up: only the tiles that meet it
 *
 * Directories are read flat for `.ocd`, `.omap` and `.xmap`. The corpus and
 * everything this writes stay in `.local/` (AGENTS.md §12): `summary.json`
 * names the map's colours. Standard output carries labels, palette ids and
 * numbers only.
 *
 * Exit status: 0 when every map imported and no changed pixel is
 * unclassified; 1 otherwise; 2 on usage errors.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

const MAP_EXT = /\.(ocd|omap|xmap)$/i;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATES = ["permutation"];
/** Objects whose bounding box comes this close to a tile are drawn into it (line widths, glyphs). */
const TILE_MARGIN_UM = 5000;

function usage(message) {
  if (message) console.error(message);
  console.error(
    "usage: node scripts/measure-colour-order.mjs <file|dir>… [--maps <tsv>] [--out <dir>] [--classes <json>] [--candidate permutation]\n" +
      "       [--tile-mm 60] [--px-per-mm 6] [--tolerance 16] [--worst 3] [--worst-px-per-mm 12] [--window x0,y0,x1,y1]",
  );
  process.exit(2);
}

const NUMERIC = { "--tile-mm": "tileMm", "--px-per-mm": "pxPerMm", "--tolerance": "tolerance", "--worst": "worst", "--worst-px-per-mm": "worstPxPerMm" };

function parseArgs(argv) {
  const opts = { paths: [], maps: null, out: join(ROOT, ".local", "colour-order"), classes: null, candidate: "permutation", tileMm: 60, pxPerMm: 6, tolerance: 16, worst: 3, worstPxPerMm: 12, window: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v === "") usage(`${flag} needs a value`);
      return v;
    };
    if (flag in NUMERIC) {
      const v = Number(value());
      if (!Number.isFinite(v) || v < 0 || (flag !== "--tolerance" && flag !== "--worst" && v === 0)) usage(`${flag}: not a valid number`);
      opts[NUMERIC[flag]] = v;
    } else if (flag === "--maps" || flag === "--out" || flag === "--classes") opts[flag.slice(2)] = value();
    else if (flag === "--candidate") {
      opts.candidate = value();
      if (!CANDIDATES.includes(opts.candidate)) usage(`--candidate: one of ${CANDIDATES.join(", ")}`);
    } else if (flag === "--window") {
      const w = value().split(",").map(Number);
      if (w.length !== 4 || w.some((v) => !Number.isFinite(v)) || w[2] <= w[0] || w[3] <= w[1]) usage("--window: x0,y0,x1,y1 in paper mm, x0 < x1 and y0 < y1");
      opts.window = { minX: w[0] * 1000, minY: w[1] * 1000, maxX: w[2] * 1000, maxY: w[3] * 1000 };
    } else if (a.startsWith("--")) usage(`unknown option ${flag}`);
    else opts.paths.push(a);
  }
  if (opts.paths.length === 0 && !opts.maps) usage();
  const out = resolve(opts.out);
  if (!`${out}${sep}`.includes(`${sep}.local${sep}colour-order${sep}`)) usage(`--out: ${out} is not under a .local/colour-order/ directory (corpus output is never committed)`);
  opts.out = out;
  return opts;
}

const labelOf = (path) => basename(path, extname(path));

function listMaps(opts) {
  const maps = [];
  const add = (label, path) => maps.push({ label, path });
  const statOrUsage = (p) => {
    try {
      return statSync(p);
    } catch {
      return usage(`${p}: no such file or directory`);
    }
  };
  if (opts.maps) {
    let text;
    try {
      text = readFileSync(opts.maps, "utf8");
    } catch {
      usage(`--maps: cannot read ${opts.maps}`);
    }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const tab = raw.indexOf("\t");
      const [label, path] = tab >= 0 ? [raw.slice(0, tab).trim(), raw.slice(tab + 1).trim()] : [labelOf(line), line];
      statOrUsage(path);
      add(label, path);
    }
  }
  for (const p of opts.paths) {
    if (statOrUsage(p).isDirectory()) {
      for (const name of readdirSync(p).sort()) {
        const f = join(p, name);
        if (MAP_EXT.test(name) && statSync(f).isFile()) add(labelOf(name), f);
      }
    } else add(labelOf(p), p);
  }
  const seen = new Set();
  for (const m of maps) {
    if (!/^[\w.-]+$/.test(m.label)) usage(`label "${m.label}": letters, digits, ".", "-" and "_" only`);
    if (seen.has(m.label)) usage(`two maps labelled ${m.label}`);
    seen.add(m.label);
  }
  if (maps.length === 0) usage("no maps");
  return maps;
}

const pct = (n, d, digits = 3) => (d ? `${((100 * n) / d).toFixed(digits)} %` : "—");
const int = (n) => n.toLocaleString("en-US").replace(/,/g, " ");

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const maps = listMaps(opts);
  let classification = { version: 1, rules: [] };

  // The API's TypeScript sources, loaded as the import worker loads them.
  register();
  const api = join(ROOT, "packages", "api", "src");
  const { importMapToDocument } = await import(join(api, "import", "ocad.ts"));
  const { sniffMapKind } = await import(join(api, "map-store", "uploads.ts"));
  const { rasterisePassStream, encodePng } = await import(join(api, "render", "reference-raster.ts"));
  const { glyphOutlineFrom, loadBundledFonts } = await import(join(api, "render", "fonts.ts"));
  const co = await import(join(api, "render", "colour-order-diff.ts"));
  const { mapDocument, mapImport, render, symbolLibrary } = await import(join(ROOT, "packages", "shared", "src", "index.ts"));

  if (opts.classes) {
    try {
      classification = co.parseClassification(JSON.parse(readFileSync(opts.classes, "utf8")));
    } catch (err) {
      usage(`--classes: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const fonts = await loadBundledFonts();
  const glyphOutline = glyphOutlineFrom(fonts);

  /** The pass stream of `doc`'s objects near `bounds` (µm). */
  function streamOf(doc, bounds) {
    const H = doc.header;
    const k = H.unitsPerMm / 1000;
    const b = { minX: (bounds.minX - TILE_MARGIN_UM) * k, minY: (bounds.minY - TILE_MARGIN_UM) * k, maxX: (bounds.maxX + TILE_MARGIN_UM) * k, maxY: (bounds.maxY + TILE_MARGIN_UM) * k };
    const only = [];
    for (let i = 0; i < H.objects.count; i++) {
      const o = i * 4;
      if (doc.bboxes[o] <= b.maxX && doc.bboxes[o + 2] >= b.minX && doc.bboxes[o + 1] <= b.maxY && doc.bboxes[o + 3] >= b.minY) only.push(i);
    }
    const input = mapDocument.documentRenderInput(doc, { only });
    return render.symbolise({ objects: input.objects, symbols: input.symbols, fonts }).stream;
  }

  /** The visible raster: each stack row in its own CMYK, on white. */
  function visible(doc, stream, bounds, pxPerMm) {
    const hex = doc.header.colours.map((c) => render.cmykToHex(c.cmyk));
    return rasterisePassStream(stream, { colour: (i) => hex[i] ?? "#ff00ff", bounds, pxPerMm, background: "#ffffff", glyphOutline });
  }

  /** How many shared top layers are peeled off, at most, to find a change under them (§6.5 "Naming"). */
  const PEEL_DEPTH = 3;

  /**
   * Names the changed pixels of one tile (§6.5 "Naming"): by the layers on
   * top in the two paint images, else the pair of layers around the pixel
   * whose order flipped; where both orders have the same layer on top, the
   * same again on paint images with that layer peeled off (up to
   * PEEL_DEPTH); else by the neighbours.
   */
  async function nameTile(mask, width, height, streams, side) {
    const paintView = async (peel) => {
      const rows = (layers) => new Set(layers.filter((l) => peel.includes(l.name)).map((l) => l.row));
      const [sa, sb] = peel.length ? [co.withoutRows(streams[0], rows(side.sourceLayers)), co.withoutRows(streams[1], rows(side.candidateLayers))] : streams;
      const pa = await co.rasterisePaints(sa, { bounds: side.bounds, pxPerMm: opts.pxPerMm, glyphOutline });
      const pb = await co.rasterisePaints(sb, { bounds: side.bounds, pxPerMm: opts.pxPerMm, glyphOutline });
      return {
        source: pa.ids,
        candidate: pb.ids,
        nameSource: co.paintNamer(pa.paints, side.sourceLayers, side.symbols),
        nameCandidate: co.paintNamer(pb.paints, side.candidateLayers, side.symbols),
      };
    };
    const kindAt = new Map();
    let pending = new Map([["", { peel: [], pixels: [] }]]);
    for (let i = 0; i < mask.length; i++) if (mask[i]) pending.get("").pixels.push(i);
    for (let depth = 0; depth <= PEEL_DEPTH && pending.size; depth++) {
      const groups = [...pending.values()];
      pending = new Map();
      for (const { peel, pixels } of groups) {
        const v = await paintView(peel);
        const kindOf = co.viewKindOf(v, width, height, side.rowOf);
        for (const i of pixels) {
          const k = kindOf(i);
          if (k) {
            kindAt.set(i, k);
            continue;
          }
          const top = co.sharedTop(v, i);
          if (!top || depth === PEEL_DEPTH) continue;
          const next = [...peel, top];
          const key = [...next].sort().join("\n");
          if (!pending.has(key)) pending.set(key, { peel: next, pixels: [] });
          pending.get(key).pixels.push(i);
        }
      }
    }
    return co.nameChanges(mask, width, height, (i) => kindAt.get(i));
  }

  mkdirSync(opts.out, { recursive: true });
  const results = [];
  for (const { label, path } of maps) {
    const started = Date.now();
    const file = readFileSync(path);
    const kind = sniffMapKind(file.subarray(0, 1024));
    console.log(`\n=== ${label}`);
    if (!kind) {
      console.log("  ERROR not an OCAD or Mapper file");
      results.push({ label, error: "not an OCAD or Mapper file" });
      continue;
    }
    let m;
    try {
      // As the import worker does on a first import: no club decisions.
      const imported = await importMapToDocument(file, label, kind, { match: { decisions: [] } });
      const doc = mapDocument.decodeMapDocument(new Uint8Array(imported.bytes));
      const H = doc.header;
      const libId = H.library?.id ?? mapImport.chooseLibrary(H.mapScale);
      const spec = symbolLibrary.getSymbolLibrary(libId).spec;
      const edition = mapImport.detectPaletteEdition(H.colours);
      const rank = co.paletteRank(edition, spec);
      const identified = mapImport.identifySourceColours(H.colours, spec, edition).map((i) => i.paletteId);
      const perSymbol = co.objectsPerSymbol(doc);
      const sourceLayers = co.stackLayers(H.colours, H.symbols, mapDocument.documentRenderInput(doc).symbols, perSymbol, identified, rank);

      // The candidate (I1: the experiment's permutation; from I3 on the importer's layers).
      const order = co.permutationOrder(sourceLayers, rank);
      const candidateDoc = co.permuteStack(doc, order);
      const candidateLayers = order.map((old, row) => ({ ...sourceLayers[old], row }));
      const census = co.colourCensus(doc, sourceLayers, perSymbol);
      const byName = new Map(sourceLayers.map((l) => [l.name, l]));
      const layerName = (paint) => (paint.startsWith(co.GRAPHIC_PREFIX) ? paint.slice(co.GRAPHIC_PREFIX.length) : paint);
      const rowsOf = (layers) => new Map(layers.map((l) => [l.name, l.row]));
      const sourceRows = rowsOf(sourceLayers), candidateRows = rowsOf(candidateLayers);
      const rowOf = { source: (n) => sourceRows.get(layerName(n)), candidate: (n) => candidateRows.get(layerName(n)) };

      const k = 1000 / H.unitsPerMm;
      const full = { minX: H.bounds.minX * k, minY: H.bounds.minY * k, maxX: H.bounds.maxX * k, maxY: H.bounds.maxY * k };
      const grid = co.tileGrid(full, opts.tileMm, opts.window ?? undefined);
      const kinds = new Map();
      const tiles = [];
      let px = 0, inked = 0, changed = 0;
      for (const t of grid.tiles) {
        const sa = streamOf(doc, t.bounds), sb = streamOf(candidateDoc, t.bounds);
        const a = await visible(doc, sa, t.bounds, opts.pxPerMm);
        const b = await visible(candidateDoc, sb, t.bounds, opts.pxPerMm);
        const d = co.changedMask(a, b, opts.tolerance);
        px += a.width * a.height;
        inked += d.inked;
        changed += d.changed;
        let unattributed = 0;
        if (d.changed) {
          // The paint images are drawn only where something changed.
          const named = await nameTile(d.mask, a.width, a.height, [sa, sb], { bounds: t.bounds, sourceLayers, candidateLayers, symbols: H.symbols, rowOf });
          for (const [key, n] of named) kinds.set(key, (kinds.get(key) ?? 0) + n);
          unattributed = named.get(co.UNATTRIBUTED) ?? 0;
        }
        tiles.push({ x: t.x, y: t.y, boundsMm: [t.bounds.minX, t.bounds.minY, t.bounds.maxX, t.bounds.maxY].map((v) => v / 1000), px: a.width * a.height, changed: d.changed, unattributed });
      }

      const result = co.classify(kinds, classification, label);
      const layerOf = (name) => byName.get(layerName(name));
      const kindRows = result.kinds.map((r) => ({ ...r, suggested: co.suggestClass(r.from, r.to, layerOf, rank) }));
      const unattributed = kinds.get(co.UNATTRIBUTED) ?? 0;

      const dir = join(opts.out, label);
      mkdirSync(dir, { recursive: true });
      const worst = [];
      for (const [n, t] of co.rankTiles(tiles, opts.worst).entries()) {
        const bounds = { minX: t.boundsMm[0] * 1000, minY: t.boundsMm[1] * 1000, maxX: t.boundsMm[2] * 1000, maxY: t.boundsMm[3] * 1000 };
        const a = await visible(doc, streamOf(doc, bounds), bounds, opts.worstPxPerMm);
        const b = await visible(candidateDoc, streamOf(candidateDoc, bounds), bounds, opts.worstPxPerMm);
        const name = `worst-${n + 1}-tile-${t.x}-${t.y}.png`;
        writeFileSync(join(dir, name), await encodePng(co.sideBySide(a, b, co.changedMask(a, b, opts.tolerance).mask)));
        worst.push({ x: t.x, y: t.y, changed: t.changed, file: name });
      }
      const suggestedRules = kindRows
        .filter((r) => r.suggested)
        .map((r) => ({ map: label, from: r.from, to: r.to, class: r.suggested, note: `suggested; ${r.px} px` }));

      m = {
        label,
        fileHash: imported.fileHash,
        importer: H.format.importer,
        library: libId,
        edition,
        candidate: opts.candidate,
        settings: { tileMm: opts.tileMm, pxPerMm: opts.pxPerMm, tolerance: opts.tolerance, window: opts.window },
        census: {
          ...census,
          unidentifiedList: sourceLayers.filter((l) => l.uses > 0 && l.roles.length === 0).map((l) => ({ row: l.row, name: H.colours[l.row].name, layer: l.name, uses: l.uses })),
        },
        tiles: tiles.length,
        tilesChanged: tiles.filter((t) => t.changed).length,
        tilesOver1pct: tiles.filter((t) => t.changed / t.px > 0.01).length,
        px,
        inked,
        changedPx: changed,
        namedPx: changed - unattributed,
        namedShare: changed ? (changed - unattributed) / changed : 1,
        kinds: kindRows,
        byClass: result.byClass,
        unclassifiedPx: result.unclassified,
        unclassifiedShare: result.unclassifiedShare,
        unusedRules: result.unusedRules,
        worst,
        seconds: (Date.now() - started) / 1000,
      };
      writeFileSync(join(dir, "summary.json"), JSON.stringify(m, null, 1) + "\n");
      writeFileSync(join(dir, "tiles.json"), JSON.stringify({ nx: grid.nx, ny: grid.ny, tileMm: opts.tileMm, tiles }, null, 1) + "\n");
      writeFileSync(join(dir, "classes.suggested.json"), JSON.stringify({ version: 1, rules: suggestedRules }, null, 1) + "\n");
      printMap(m);
    } catch (err) {
      m = { label, error: err instanceof Error ? err.stack ?? err.message : String(err) };
      console.log(`  ERROR ${m.error}`);
    }
    results.push(m);
  }

  const ok = results.filter((r) => !r.error);
  const errors = results.length - ok.length;
  const changedAll = ok.reduce((t, r) => t + r.changedPx, 0);
  const unclassifiedAll = ok.reduce((t, r) => t + r.unclassifiedPx, 0);
  console.log(`\n=== summary: ${results.length} maps, candidate ${opts.candidate}, tolerance ${opts.tolerance}`);
  for (const r of ok) console.log(`  ${r.label.padEnd(24)} changed ${pct(r.changedPx, r.px)} of pixels, ${pct(r.changedPx, r.inked)} of ink; unclassified ${pct(r.unclassifiedPx, r.changedPx, 1)} of changed`);
  console.log(`  import errors   ${errors}  ${errors ? "FAIL" : "pass"}`);
  console.log(`  unclassified    ${int(unclassifiedAll)} of ${int(changedAll)} changed px (${pct(unclassifiedAll, changedAll, 1)})  ${unclassifiedAll ? "FAIL" : "pass"}`);
  console.log(`  written to      ${opts.out}`);
  writeFileSync(join(opts.out, "run.json"), JSON.stringify({ tool: "measure-colour-order", ranAt: new Date().toISOString(), node: process.version, candidate: opts.candidate, tolerance: opts.tolerance, maps: Object.fromEntries(results.map(({ label, ...r }) => [label, r.error ? { error: r.error } : { changedPx: r.changedPx, px: r.px, inked: r.inked, unclassifiedPx: r.unclassifiedPx, namedShare: r.namedShare }])) }, null, 1) + "\n");
  process.exit(errors || unclassifiedAll ? 1 : 0);
}

function printMap(m) {
  const c = m.census;
  const s = c.symbols;
  console.log(`  map        ${m.library} ${m.edition}, importer ${m.importer}, candidate ${m.candidate}`);
  console.log(`  census     colours ${c.colours}  used ${c.used}  no palette entry ${c.unidentified} (${c.unidentifiedUses} of ${c.uses} uses)  multi-role ${c.multi.length}${c.multi.length ? ` (${c.multi.map((x) => `${x.roles.join("+")} ${x.uses}`).join(", ")})` : ""}`);
  console.log(`             symbols used ${s.used}: auto ${s.auto} / suggested ${s.suggested} / unmatched ${s.unmatched} / none ${s.none} (reviewed ${s.reviewed}, graphic ${s.graphic})  lower purple at ${c.lowerAt}  upper at ${c.upperAt}`);
  console.log(`  tiles      ${m.tiles} of ${m.settings.tileMm} mm at ${m.settings.pxPerMm} px/mm; changed in ${m.tilesChanged}, over 1 % in ${m.tilesOver1pct}`);
  console.log(`  changed    ${int(m.changedPx)} px of ${int(m.px)} (${pct(m.changedPx, m.px)}), of ink ${int(m.inked)} (${pct(m.changedPx, m.inked)}); named ${pct(m.namedPx, m.changedPx, 1)}`);
  for (const k of m.kinds.slice(0, 20)) console.log(`  ${String(k.px).padStart(9)}  ${k.from} → ${k.to}  [${k.class}${k.suggested ? `; suggested ${k.suggested}` : ""}]`);
  if (m.kinds.length > 20) console.log(`  ${" ".repeat(9)}  … ${m.kinds.length - 20} more kinds in summary.json`);
  console.log(`  classes    ${Object.entries(m.byClass).filter(([, v]) => v).map(([k, v]) => `${k} ${int(v)}`).join(", ") || "nothing changed"}  — unclassified ${pct(m.unclassifiedPx, m.changedPx, 1)} of changed`);
  if (m.unusedRules.length) console.log(`  unused     rules ${m.unusedRules.join(", ")}`);
  for (const w of m.worst) console.log(`  worst      tile ${w.x},${w.y}  ${w.changed} px  ${w.file}`);
  console.log(`  time       ${m.seconds.toFixed(1)} s`);
}

await main();
