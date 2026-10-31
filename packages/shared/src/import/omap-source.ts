/**
 * OpenOrienteering Mapper source → map document input (docs/map-import.md
 * §4; research record 06 §3.2–3.3 "one normaliser, two readers").
 *
 * Takes the `readOmap` result and produces the same `MapDocumentInput` the
 * OCAD path produces, so stages 6–8 (matcher, colour alignment, encoding)
 * run unchanged: objects with int32 coordinates in Mapper's native 0.001 mm
 * (y negated — Mapper's y grows downward, the document's grows upward) and
 * `COORD_FLAG` bytes, the colour stack in draw order (priority reversed),
 * the symbol table converted by `omap-symbols.ts`, georeferencing from the
 * `<georeferencing>` block, the print area, and stable warning codes.
 */

import type { MapDocumentInput, MapObjectInput } from "../map-document/codec.js";
import { analyseDocumentInput, type DocumentAnalysis } from "./analyse.js";
import { OBJECT_TYPE } from "../map-document/header.js";
import { WARNING_DETAILS_MAX, type ImportWarningDetail } from "./report.js";
import type { DocumentColour, DocumentSymbolInput, DocumentWarning, Georeferencing, MapDocumentHeaderInput } from "../map-document/header.js";
import type { TextSymbol } from "../render/symbol.js";
import { OMAP_OBJECT_TYPE, type OmapCoord, type OmapFile, type OmapGeoreferencing, type OmapSymbol } from "./omap-reader.js";
import { dashPointRule, omapFlags, omapGoverningLine, omapSymbolKind, omapSymbolToRender, type DashPointRule } from "./omap-symbols.js";

/** Mapper coordinates are 0.001 mm. */
export const OMAP_UNITS_PER_MM = 1000;
export const OMAP_IMPORTER_VERSION = "omap-9";

export interface OmapSourceOptions {
  /** Upload name; goes into the import report, not into the document. */
  fileName: string;
  /** SHA-256 hex of the file. */
  fileHash: string;
  fileBytes: number;
  importer?: string;
}

export interface OmapSourceResult {
  input: MapDocumentInput;
  counts: {
    objects: number; coordinates: number; symbols: number; colours: number; texts: number; graphicObjects: number; missingSymbolObjects: number;
    symbolsRendered: number; symbolsUnrendered: number;
  };
  warnings: DocumentWarning[];
  /** One entry per warning emission that carries a message (docs/map-import.md §3.6), at most `WARNING_DETAILS_MAX`; for the import report, not the document. */
  warningDetails: ImportWarningDetail[];
  /** Stage 5 over `input` (docs/map-import.md §3.8); not part of the document. */
  analysis: DocumentAnalysis;
}

/** 1e-6 m: far below Mapper's own precision, and no unrounded sin/cos result reaches the document bytes (docs/map-import.md §6). */
const roundMicrometre = (v: number): number => Math.round(v * 1e6) / 1e6;

const radToDeciDeg = (rad: number): number => Math.round((rad * 1800) / Math.PI);

/**
 * A Mapper box text's corners — bottom-left, bottom-right, top-right,
 * top-left on paper — from its centre anchor, size and rotation, in the
 * reader's y-down coordinates like every other `OmapCoord`. Unrotated
 * boxes stay in integers (the width and height exact); a rotated box
 * needs `cos` / `sin` and is rounded to native units (§6).
 */
function boxCorners(c: OmapCoord, size: { width: number; height: number }, rotation: number): OmapCoord[] {
  const cx = c.x, cy = -c.y; // y-up
  const w = size.width, h = size.height;
  let up: [number, number][];
  if (!rotation) {
    const x0 = cx - Math.floor(w / 2), y0 = cy - Math.floor(h / 2);
    up = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]];
  } else {
    const cos = Math.cos(rotation), sin = Math.sin(rotation);
    up = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
      const lx = (sx * w) / 2, ly = (sy * h) / 2;
      return [Math.round(cx + lx * cos - ly * sin), Math.round(cy + lx * sin + ly * cos)];
    });
  }
  return up.map(([x, y]) => ({ x, y: y === 0 ? 0 : -y, flags: 0 }));
}

/** Colour list (index = priority, 0 on top) → colour stack (index = draw order, 0 first). */
export function omapColourStack(file: OmapFile): { colours: DocumentColour[]; stackIdxByPriority: Map<number, number>; opacityIgnored: number } {
  const n = file.colours.length;
  const colours: DocumentColour[] = [];
  const stackIdxByPriority = new Map<number, number>();
  let opacityIgnored = 0;
  for (let i = n - 1; i >= 0; i--) {
    const c = file.colours[i];
    const entry: DocumentColour = {
      id: `src:${c.priority}`,
      name: c.name,
      cmyk: [c.c, c.m, c.y, c.k],
      sourceNumber: c.priority,
    };
    if (c.spotName !== undefined || c.knockout) {
      entry.spot = {};
      if (c.spotName !== undefined) entry.spot.name = c.spotName;
      if (c.knockout) entry.spot.knockout = true;
    }
    if (c.opacity < 1) opacityIgnored++;
    stackIdxByPriority.set(c.priority, colours.length);
    colours.push(entry);
  }
  return { colours, stackIdxByPriority, opacityIgnored };
}

export interface OmapCrsResolution {
  crs: Georeferencing["crs"];
  /** Set when the CRS could not be mapped to an EPSG code. */
  unresolved?: string;
}

/** Mapper CRS id + parameters / PROJ.4 spec → EPSG reference. */
export function omapResolveCrs(g: OmapGeoreferencing): OmapCrsResolution {
  const pc = g.projectedCrs;
  if (!pc || pc.id === "" || pc.id === "Local" || pc.id === "Local coordinates") return { crs: null };
  const epsg = (code: number, name: string): OmapCrsResolution => ({ crs: { authority: "EPSG", code, name } });
  const utm = (zoneText: string): OmapCrsResolution | undefined => {
    const m = /^\s*(\d{1,2})\s*([NS])?\s*$/i.exec(zoneText);
    if (!m) return undefined;
    const zone = parseInt(m[1], 10);
    if (zone < 1 || zone > 60) return undefined;
    const south = (m[2] ?? "N").toUpperCase() === "S";
    return epsg((south ? 32700 : 32600) + zone, `WGS 84 / UTM zone ${zone}${south ? "S" : "N"}`);
  };
  switch (pc.id) {
    case "EPSG": {
      const code = parseInt(pc.parameters[0] ?? "", 10);
      if (Number.isFinite(code) && code > 0) return epsg(code, `EPSG:${code}`);
      break;
    }
    case "UTM": {
      const r = utm(pc.parameters[0] ?? "");
      if (r) return r;
      break;
    }
    case "Gauss-Krueger, datum: Potsdam": {
      const zone = parseInt(pc.parameters[0] ?? "", 10);
      if (zone >= 2 && zone <= 5) return epsg(31464 + zone, `DHDN / 3-degree Gauss-Kruger zone ${zone}`);
      break;
    }
    default:
      break;
  }
  // PROJ.4 spec (the "PROJ.4" template, or an unknown template's expanded spec).
  const spec = pc.spec ?? "";
  const init = /\+init=epsg:(\d+)/i.exec(spec);
  if (init) return epsg(parseInt(init[1], 10), `EPSG:${init[1]}`);
  const zone = /\+proj=utm\b.*\+zone=(\d{1,2})/i.exec(spec);
  if (zone && /\+datum=WGS84\b/i.test(spec)) {
    const r = utm(`${zone[1]} ${/\+south\b/i.test(spec) ? "S" : "N"}`);
    if (r) return r;
  }
  return { crs: null, unresolved: `${pc.id}${pc.parameters.length ? ` (${pc.parameters.join(", ")})` : ""}${spec ? `: ${spec}` : ""}` };
}

/**
 * Mapper georeferencing → document georeferencing. `paperOrigin` is the
 * projected position of paper (0, 0), from Mapper's transform
 * `P_ref + Rot(−grivation) · (s · flipY(map − map_ref))` evaluated at
 * `map = (0, 0)`, with `s = grid_scale_factor · scale / 1000` (mm → m).
 */
export function omapGeoreferencing(g: OmapGeoreferencing): { georeferencing: Georeferencing; mapScale: number; unresolvedCrs?: string } {
  const { crs, unresolved } = omapResolveCrs(g);
  const mapScale = g.scale > 0 ? g.scale : 15000;
  let paperOrigin: Georeferencing["paperOrigin"] = null;
  const pref = g.projectedCrs?.refPoint;
  if (crs && pref) {
    const s = (g.gridScaleFactor * mapScale) / 1000;
    const dx = -g.refPoint.x * s;
    const dy = g.refPoint.y * s;
    const a = (g.grivation * Math.PI) / 180;
    paperOrigin = {
      x: roundMicrometre(pref.x + dx * Math.cos(a) + dy * Math.sin(a)),
      y: roundMicrometre(pref.y - dx * Math.sin(a) + dy * Math.cos(a)),
    };
  }
  const georeferencing: Georeferencing = {
    crs,
    paperOrigin,
    gridRotationDeg: g.grivation,
    gridScaleFactor: g.gridScaleFactor,
  };
  if (g.declination !== 0) georeferencing.declinationDeg = g.declination;
  if (crs) georeferencing.realWorldEnabled = true;
  return { georeferencing, mapScale, unresolvedCrs: unresolved };
}

function kindOfObjectType(type: number): DocumentSymbolInput["kind"] {
  switch (type) {
    case OMAP_OBJECT_TYPE.point: return "point";
    case OMAP_OBJECT_TYPE.path: return "line";
    case OMAP_OBJECT_TYPE.text: return "text";
    default: return "unknown";
  }
}

const H_ALIGN: Record<number, TextSymbol["align"] | undefined> = { 0: "left", 1: "centre", 2: "right" };
const V_ALIGN: Record<number, NonNullable<TextSymbol["verticalAlign"]> | undefined> = { 0: "baseline", 1: "top", 2: "middle", 3: "bottom" };

/** Alignment onto a text render; baseline leaves `verticalAlign` out (the IR has no default for it on purpose). */
function setTextAlignment(render: Pick<Partial<TextSymbol>, "align" | "verticalAlign">, align: TextSymbol["align"], verticalAlign: NonNullable<TextSymbol["verticalAlign"]>): void {
  render.align = align;
  if (verticalAlign === "baseline") delete render.verticalAlign;
  else render.verticalAlign = verticalAlign;
}

export function omapToDocumentInput(file: OmapFile, opts: OmapSourceOptions): OmapSourceResult {
  const warnings = new Map<string, DocumentWarning>();
  const warningDetails: ImportWarningDetail[] = [];
  const warn = (code: string, message?: string, count = 1, symbolIdx?: number) => {
    const w = warnings.get(code);
    if (w) w.count += count;
    else warnings.set(code, { code, count, message });
    if (message !== undefined && warningDetails.length < WARNING_DETAILS_MAX) {
      warningDetails.push(symbolIdx === undefined ? { code, message } : { code, message, symbolIdx });
    }
  };

  const { colours, stackIdxByPriority, opacityIgnored } = omapColourStack(file);
  if (opacityIgnored) warn("COLOUR_OPACITY_IGNORED", `${opacityIgnored} colour(s) with opacity < 1 are drawn opaque`, opacityIgnored);

  const symbolById = (id: number): OmapSymbol | undefined => file.symbols[id];
  const conversionCtx = { colourIndex: (p: number) => stackIdxByPriority.get(p), symbolById };

  // Symbol table in list order; definitions converted to the render IR.
  const symbols: DocumentSymbolInput[] = [];
  const dashRules: DashPointRule[] = [];
  const symbolKinds: (DocumentSymbolInput["kind"] | undefined)[] = [];
  let symbolsRendered = 0, symbolsUnrendered = 0, helpersHidden = 0;
  file.symbols.forEach((s, i) => {
    const conv = omapSymbolToRender(s, conversionCtx);
    for (const w of conv.warnings) warn(w.code, w.message, 1, i);
    if (conv.render) symbolsRendered++;
    else symbolsUnrendered++;
    const kind = omapSymbolKind(s, symbolById);
    symbolKinds.push(kind);
    dashRules.push(dashPointRule(omapGoverningLine(s, symbolById)));
    if (s.helper && !s.hidden) helpersHidden++;
    const entry: DocumentSymbolInput = {
      code: s.code,
      name: s.name,
      kind: kind ?? "unknown",
      origin: "source",
      hidden: s.hidden || s.helper,
      sourceIndex: i,
      render: conv.render,
    };
    if (s.body?.kind === "text" && s.body.fontFamily) entry.sourceFont = s.body.fontFamily;
    symbols.push(entry);
  });
  if (helpersHidden) warn("HELPER_SYMBOLS_HIDDEN", `${helpersHidden} helper symbol(s) are hidden (Mapper does not print them)`, helpersHidden);

  const missingIdx = new Map<string, number>();
  const objects: MapObjectInput[] = [];
  const counts = { objects: 0, coordinates: 0, symbols: 0, colours: colours.length, texts: 0, graphicObjects: 0, missingSymbolObjects: 0, symbolsRendered, symbolsUnrendered };
  // Text objects of source symbols with their (horizontal, vertical) alignment, in object order (§4.4).
  const textAligns: { obj: MapObjectInput; align: TextSymbol["align"]; verticalAlign: NonNullable<TextSymbol["verticalAlign"]> }[] = [];
  let tagsDropped = 0;

  let sourceIndex = 0;
  for (const part of file.parts) {
    for (const o of part.objects) {
      const idx = sourceIndex++;
      if (o.coords.length === 0) {
        warn("EMPTY_GEOMETRY_DROPPED");
        continue;
      }
      if (o.type !== OMAP_OBJECT_TYPE.point && o.type !== OMAP_OBJECT_TYPE.path && o.type !== OMAP_OBJECT_TYPE.text) {
        warn("UNKNOWN_OBJECT_TYPE", `object type ${o.type}`);
        continue;
      }
      let symbolIdx: number;
      let kind: DocumentSymbolInput["kind"] | undefined;
      const src = o.symbol >= 0 ? file.symbols[o.symbol] : undefined;
      if (src && symbolKinds[o.symbol]) {
        symbolIdx = o.symbol;
        kind = symbolKinds[o.symbol];
      } else {
        const key = `${o.symbol}/${o.type}`;
        let m = missingIdx.get(key);
        if (m === undefined) {
          m = symbols.length;
          missingIdx.set(key, m);
          symbols.push({ code: src?.code ?? `#${o.symbol}`, name: src?.name ?? "", kind: kindOfObjectType(o.type), origin: "missing", hidden: false, render: null });
          dashRules.push("corner");
          warn("MISSING_SYMBOL", src ? `objects use symbol ${src.code}, which has no usable definition` : `objects reference symbol ${o.symbol}, which is not in the symbol table`, 1, m);
        }
        symbolIdx = m;
        kind = kindOfObjectType(o.type);
        counts.missingSymbolObjects++;
      }

      let type: number;
      let coordsIn = o.coords;
      let angleDeciDeg: number | undefined;
      switch (o.type) {
        case OMAP_OBJECT_TYPE.point:
          type = OBJECT_TYPE.point;
          coordsIn = o.coords.slice(0, 1);
          if (o.rotation) angleDeciDeg = radToDeciDeg(o.rotation);
          break;
        case OMAP_OBJECT_TYPE.text:
          // A box text is formatted text: its four corners from the centre anchor and the size (§4.2).
          type = o.boxSize ? OBJECT_TYPE.formattedText : OBJECT_TYPE.text;
          coordsIn = o.boxSize ? boxCorners(o.coords[0], o.boxSize, o.rotation) : o.coords.slice(0, 1);
          if (o.rotation) angleDeciDeg = radToDeciDeg(o.rotation);
          break;
        default:
          type = kind === "area" ? OBJECT_TYPE.area : OBJECT_TYPE.line;
          if (kind === "area" && o.patternRotation) angleDeciDeg = radToDeciDeg(o.patternRotation);
          break;
      }
      if (o.tags) tagsDropped++;

      const n = coordsIn.length;
      const coords = new Int32Array(n * 2);
      for (let k = 0; k < n; k++) {
        coords[k * 2] = coordsIn[k].x;
        coords[k * 2 + 1] = -coordsIn[k].y;
      }
      const flags = Uint8Array.from(omapFlags(coordsIn, dashRules[symbolIdx] ?? "corner"));
      const obj: MapObjectInput = { symbolIdx, type, sourceIndex: idx, coords, flags };
      if (angleDeciDeg) obj.angleDeciDeg = angleDeciDeg;
      if (type === OBJECT_TYPE.text || type === OBJECT_TYPE.formattedText) {
        if (!o.text) {
          warn("EMPTY_TEXT_DROPPED");
          continue;
        }
        obj.text = o.text;
        counts.texts++;
        if (symbolIdx === o.symbol) {
          textAligns.push({ obj, align: H_ALIGN[o.hAlign ?? 0] ?? "left", verticalAlign: V_ALIGN[o.vAlign ?? 0] ?? "baseline" });
        }
      }
      objects.push(obj);
      counts.coordinates += n;
    }
  }

  // Per-object text alignment (§4.4): a text symbol takes the first (h, v) pair its objects use; each further pair
  // gets an appended variant entry, and the objects with that pair point at it.
  const variantIdx = new Map<string, number>();
  const firstPair = new Map<number, string>();
  for (const { obj, align, verticalAlign } of textAligns) {
    const parentIdx = obj.symbolIdx;
    const parent = symbols[parentIdx];
    if (!parent.render || parent.render.type !== "text") continue;
    const pair = `${align}/${verticalAlign}`;
    const first = firstPair.get(parentIdx);
    if (first === undefined) {
      firstPair.set(parentIdx, pair);
      setTextAlignment(parent.render, align, verticalAlign);
      continue;
    }
    if (pair === first) continue;
    const key = `${parentIdx}/${pair}`;
    let idx = variantIdx.get(key);
    if (idx === undefined) {
      idx = symbols.length;
      variantIdx.set(key, idx);
      const render = { ...structuredClone(parent.render), id: `${parent.render.id}/${pair}` };
      setTextAlignment(render, align, verticalAlign);
      symbols.push({ ...parent, render });
      counts.symbolsRendered++;
    }
    obj.symbolIdx = idx;
  }
  counts.objects = objects.length;
  counts.symbols = symbols.length;
  if (tagsDropped) warn("OBJECT_TAGS_DROPPED", `${tagsDropped} object(s) carried tags, which the document does not store`, tagsDropped);
  if (file.parts.length > 1) warn("PARTS_MERGED", `${file.parts.length} map parts merged: ${file.parts.map((p) => p.name).join(", ")}`, file.parts.length - 1);
  if (file.templates.length) warn("TEMPLATES_DROPPED", `${file.templates.length} template(s) referenced by the map are not imported: ${file.templates.map((t) => t.name).join(", ")}`, file.templates.length);
  for (const w of file.warnings) warn(w.code, w.message, w.count);

  const { georeferencing, mapScale, unresolvedCrs } = omapGeoreferencing(file.georeferencing);
  if (unresolvedCrs) warn("CRS_UNRESOLVED", `coordinate reference system not mapped to EPSG: ${unresolvedCrs}`);
  if (file.georeferencing.scale <= 0) warn("MAP_SCALE_MISSING", "no map scale in the file; 1:15000 assumed");

  const pa = file.print?.area;
  const printWindow = pa
    ? { scale: file.print?.scale && file.print.scale > 0 ? file.print.scale : undefined, left: pa.left, right: pa.left + pa.width, top: 0 - pa.top, bottom: 0 - (pa.top + pa.height) }
    : null;

  const header: Omit<MapDocumentHeaderInput, "bounds" | "strings" | "objects"> = {
    format: { version: 1, importer: opts.importer ?? OMAP_IMPORTER_VERSION },
    source: { kind: "omap", version: String(file.version), hash: opts.fileHash, bytes: opts.fileBytes },
    unitsPerMm: OMAP_UNITS_PER_MM,
    mapScale,
    georeferencing,
    printWindow,
    exportRectangles: [],
    colours,
    symbols,
    warnings: [...warnings.values()],
  };
  const input: MapDocumentInput = { header, objects };
  return { input, counts, warnings: [...warnings.values()], warningDetails, analysis: analyseDocumentInput(input) };
}
