/**
 * OCAD source → map document input (docs/map-import.md, slice A; research
 * record 06 §3.3 "one normaliser, two readers").
 *
 * Takes the fork's `readOcad` result as plain data — typed structurally
 * here so the shared package has no dependency on `ocad2geojson` — and
 * produces the `MapDocumentInput` the codec encodes: objects with
 * verbatim int32 coordinates and `COORD_FLAG` bytes, the colour stack in
 * draw order, the symbol table as metadata, georeferencing from ScalePar,
 * the print window, and stable warning codes for what was dropped.
 *
 * Symbol definitions are converted to the render IR by `ocad-symbols.ts`
 * (03 Appendix C); a symbol whose definition cannot be expressed keeps
 * `render: null` and the render bridge draws a proxy. Not here yet: the
 * 03 matcher and colour alignment.
 */

import { ocadFlags } from "../render/ocad-objects.js";
import { parseRenderSymbol, type RenderSymbol } from "../render/symbol.js";
import { type OcadSymbolDefLike, ocadSymbolToRender } from "./ocad-symbols.js";
import type { MapDocumentInput, MapObjectInput } from "../map-document/codec.js";
import { analyseDocumentInput, type DocumentAnalysis } from "./analyse.js";
import { OBJECT_TYPE } from "../map-document/header.js";
import { WARNING_DETAILS_MAX, type ImportWarningDetail } from "./report.js";
import type { DocumentColour, DocumentSymbolInput, DocumentWarning, Georeferencing, MapDocumentHeaderInput } from "../map-document/header.js";

/**
 * A north-oriented point symbol (flags bit 1 clear) whose objects carry an
 * angle is drawn turned by OCAD; Mapper's OCD import makes such a symbol
 * rotatable unless it is symmetrical, and so does this (map-import §3.3,
 * C10: Club-full's 504.5 / 504.7 / 512.3 / 519.0). Centred discs and rings
 * look the same at any angle and keep `north`.
 */
function rotateFromObjectAngles(symbols: DocumentSymbolInput[], objects: MapObjectInput[]): void {
  const turned = new Set<number>();
  for (const o of objects) if (o.type === OBJECT_TYPE.point && o.angleDeciDeg) turned.add(o.symbolIdx);
  for (const idx of turned) {
    const render = symbols[idx].render;
    if (render?.type !== "point" || render.orientation === "object") continue;
    if (render.glyph.parts.every((p) => (p.kind === "disc" || p.kind === "ring") && !(p.cx ?? 0) && !(p.cy ?? 0))) continue;
    symbols[idx].render = { ...render, orientation: "object", glyph: { ...render.glyph, rotatable: true } };
  }
}

/** OCAD coordinates are 1/100 mm. */
export const OCAD_UNITS_PER_MM = 100;
export const OCAD_IMPORTER_VERSION = "ocad-14";
/** Reader warning texts kept for the import report (docs/map-import.md §3.6). */
export const READER_WARNING_TEXTS_MAX = 50;

/**
 * `ocad2geojson`'s warnings for symbol types it does not parse: anything unknown by type, and — in the wording of
 * releases before v2.2.2-oxygen.1, which skipped them — type 6 line text and type 7 rectangle by number.
 */
const READER_DROPPED_SYMBOL = /^Ignoring (rectangle|line text) symbol (\d+)\.$/;
const READER_UNKNOWN_SYMBOL_TYPE = /^Unknown symbol type (-?\d+)$/;

export interface OcadCoordinateLike {
  0: number;
  1: number;
  xFlags?: number;
  yFlags?: number;
}

export interface OcadObjectLike {
  sym: number;
  otp: number;
  ang?: number;
  text?: string;
  /** Colour number (graphic / image objects). */
  col?: number;
  /** Line width in 1/100 mm (graphic objects). */
  lineWidth?: number;
  coordinates: ArrayLike<OcadCoordinateLike>;
}

export interface OcadSymbolLike {
  /** Symbol number × 1000. */
  symNum: number;
  /** As written, e.g. "505.1". */
  number: string;
  /** 1 point, 2 line, 3 area, 4 text, 6 line text, 7 rectangle. */
  type: number;
  status?: number;
  description?: string;
  fontName?: string;
}

export interface OcadColourLike {
  number: number;
  name?: string;
  /** 0–100 each. */
  cmyk: ArrayLike<number>;
  /** Position in the colour table, 0 = topmost (drawn last). */
  renderOrder: number;
  overprint?: boolean;
  spotColors?: unknown;
}

export interface OcadParameterStringLike {
  _first?: string;
  _pairs?: { code: string; value: string }[];
  [key: string]: unknown;
}

export interface OcadFileLike {
  header: { version: number; subVersion?: number; subSubVersion?: number };
  /** Sparse: indexed by colour number. */
  colors: ArrayLike<OcadColourLike | undefined>;
  /** Full definitions (see `ocad-symbols.ts`); only the base fields are required. */
  symbols: ArrayLike<OcadSymbolDefLike>;
  objects: ArrayLike<OcadObjectLike>;
  parameterStrings: Record<string, OcadParameterStringLike[] | undefined>;
  warnings?: ArrayLike<unknown>;
  getCrs?: () => { code?: number; catalog?: string; name?: string; gridId?: number } | undefined;
}

export interface OcadSourceOptions {
  /** Upload name; goes into the import report, not into the document. */
  fileName: string;
  /** SHA-256 hex of the file. */
  fileHash: string;
  fileBytes: number;
  importer?: string;
  /**
   * Replaces the built-in symbol conversion when given (the dev page
   * plugs in the S1 pilot family this way). Return `null` for "no render".
   */
  renderFor?: (symbol: OcadSymbolDefLike) => RenderSymbol | null;
}

export interface OcadSourceResult {
  input: MapDocumentInput;
  counts: {
    objects: number; coordinates: number; symbols: number; colours: number; texts: number; graphicObjects: number; missingSymbolObjects: number;
    /** Source symbols with a render definition / without one. */
    symbolsRendered: number; symbolsUnrendered: number;
  };
  warnings: DocumentWarning[];
  /** One entry per warning emission that carries a message (docs/map-import.md §3.6), at most `WARNING_DETAILS_MAX`; for the import report, not the document. */
  warningDetails: ImportWarningDetail[];
  /** The reader's own warning texts behind `READER_WARNING`, in reader order, at most `READER_WARNING_TEXTS_MAX`; for the import report, not the document. */
  readerWarnings: string[];
  /** Stage 5 over `input` (docs/map-import.md §3.8); not part of the document. */
  analysis: DocumentAnalysis;
}

/** OCAD symbol type → document kind. */
function kindOfSymbolType(type: number): DocumentSymbolInput["kind"] {
  switch (type) {
    case 1: return "point";
    case 2: return "line";
    case 3: return "area";
    case 4: case 6: return "text";
    case 7: return "rectangle";
    default: return "unknown";
  }
}

function kindOfObjectType(otp: number): DocumentSymbolInput["kind"] {
  switch (otp) {
    case OBJECT_TYPE.point: return "point";
    case OBJECT_TYPE.line: return "line";
    case OBJECT_TYPE.area: return "area";
    case OBJECT_TYPE.text: case OBJECT_TYPE.formattedText: case OBJECT_TYPE.lineText: return "text";
    case OBJECT_TYPE.rectangle: return "rectangle";
    default: return "unknown";
  }
}

function pairs(ps: OcadParameterStringLike | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of ps?._pairs ?? []) if (!m.has(p.code)) m.set(p.code, p.value);
  return m;
}

const num = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Colour table → colour stack (index = draw order, 0 first). */
export function ocadColourStack(colors: OcadFileLike["colors"]): DocumentColour[] {
  const list: OcadColourLike[] = [];
  for (let i = 0; i < colors.length; i++) {
    const c = colors[i];
    if (c) list.push(c);
  }
  // renderOrder 0 is the top of OCAD's table = drawn last.
  list.sort((a, b) => b.renderOrder - a.renderOrder || a.number - b.number);
  return list.map((c) => {
    const entry: DocumentColour = {
      id: `src:${c.number}`,
      name: c.name ?? "",
      cmyk: [c.cmyk[0] / 100, c.cmyk[1] / 100, c.cmyk[2] / 100, c.cmyk[3] / 100],
      sourceNumber: c.number,
    };
    if (c.overprint) entry.overprint = true;
    return entry;
  });
}

/**
 * ScalePar (1039) → document georeferencing (docs/map-import.md §3.5).
 * The CRS comes from the reader's grid table (`i`), else from the OCAD
 * 2018 EPSG code `e`. A real-world grid (`r = 1`, `i ≠ 0` or `e`) that
 * neither resolves is named in `unresolvedCrs`. `d` is the real-world
 * grid distance in metres and is not carried.
 */
export function ocadGeoreferencing(ocad: OcadFileLike): { georeferencing: Georeferencing; mapScale: number; unresolvedCrs?: string } {
  const sp = pairs(ocad.parameterStrings["1039"]?.[0]);
  const mapScale = num(sp.get("m")) ?? 15000;
  let crs: Georeferencing["crs"] = null;
  try {
    const c = ocad.getCrs?.();
    if (c?.code) crs = { authority: c.catalog ?? "EPSG", code: c.code, name: c.name ?? "" };
  } catch {
    crs = null;
  }
  const gid = num(sp.get("i"));
  const epsg = num(sp.get("e"));
  if (!crs && epsg !== undefined && Number.isInteger(epsg) && epsg > 0) crs = { authority: "EPSG", code: epsg, name: `EPSG:${epsg}` };
  const r = sp.get("r");
  const x = num(sp.get("x")), y = num(sp.get("y"));
  // `crs` and `paperOrigin` are null together (docs/map-document-format.md §2.3).
  const missingOrigin = crs !== null && (x === undefined || y === undefined) ? `${crs.authority}:${crs.code} without ScalePar x/y` : undefined;
  if (missingOrigin) crs = null;
  const georeferencing: Georeferencing = {
    crs,
    paperOrigin: crs && x !== undefined && y !== undefined ? { x, y } : null,
    gridRotationDeg: num(sp.get("a")) ?? 0,
    gridScaleFactor: (() => {
      const b = num(sp.get("b"));
      // ScalePar `b` is a correction in %, 0 = none.
      return b === undefined || b === 0 ? 1 : 1 + b / 100;
    })(),
  };
  if (r !== undefined) georeferencing.realWorldEnabled = r === "1";
  if (gid !== undefined) georeferencing.sourceGridId = gid;
  const unresolvedCrs = missingOrigin ?? (!crs && r === "1" && ((gid !== undefined && gid !== 0) || sp.get("e") !== undefined)
    ? [gid ? `grid ${gid}` : "", sp.get("e") !== undefined ? `EPSG ${sp.get("e")}` : ""].filter(Boolean).join(", ")
    : undefined);
  return unresolvedCrs ? { georeferencing, mapScale, unresolvedCrs } : { georeferencing, mapScale };
}

export function ocadToDocumentInput(ocad: OcadFileLike, opts: OcadSourceOptions): OcadSourceResult {
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

  const colours = ocadColourStack(ocad.colors);
  const stackIdxByNumber = new Map<number, number>();
  colours.forEach((c, i) => stackIdxByNumber.set(c.sourceNumber!, i));

  // Symbol table in source order; definitions converted to the render IR.
  const symbols: DocumentSymbolInput[] = [];
  const symbolIdxBySymNum = new Map<number, number>();
  const defBySymNum = new Map<number, OcadSymbolDefLike>();
  for (let i = 0; i < ocad.symbols.length; i++) {
    const s = ocad.symbols[i];
    if (!defBySymNum.has(s.symNum)) defBySymNum.set(s.symNum, s);
  }
  const conversionCtx = { colourIndex: (n: number) => stackIdxByNumber.get(n), symbolByNumber: (n: number) => defBySymNum.get(n), ocadVersion: ocad.header.version };
  let symbolsRendered = 0, symbolsUnrendered = 0;
  for (let i = 0; i < ocad.symbols.length; i++) {
    const s = ocad.symbols[i];
    let render: RenderSymbol | null;
    if (opts.renderFor) {
      render = opts.renderFor(s);
    } else {
      const conv = ocadSymbolToRender(s, conversionCtx);
      render = conv.render;
      for (const w of conv.warnings) warn(w.code, w.message, 1, i);
    }
    if (render) symbolsRendered++;
    else symbolsUnrendered++;
    const entry: DocumentSymbolInput = {
      code: s.number,
      name: s.description ?? "",
      kind: kindOfSymbolType(s.type),
      origin: "source",
      hidden: ((s.status ?? 0) & 0x02) === 0x02,
      sourceIndex: i,
      render,
    };
    if (s.fontName) entry.sourceFont = s.fontName;
    if (!symbolIdxBySymNum.has(s.symNum)) symbolIdxBySymNum.set(s.symNum, symbols.length);
    else warn("DUPLICATE_SYMBOL_NUMBER", `symbol ${s.number} defined more than once; first definition used`, 1, i);
    symbols.push(entry);
  }

  const graphicIdx = new Map<string, number>();
  const missingIdx = new Map<number, number>();
  const objects: MapObjectInput[] = [];
  const counts = { objects: 0, coordinates: 0, symbols: 0, colours: colours.length, texts: 0, graphicObjects: 0, missingSymbolObjects: 0, symbolsRendered, symbolsUnrendered };

  for (let i = 0; i < ocad.objects.length; i++) {
    const o = ocad.objects[i];
    const n = o.coordinates.length;
    if (n === 0) {
      warn("EMPTY_GEOMETRY_DROPPED");
      continue;
    }
    if (o.otp < 1 || o.otp > 7) {
      warn("UNKNOWN_OBJECT_TYPE", `object type ${o.otp}`);
      continue;
    }
    let symbolIdx: number | undefined;
    if (o.sym <= -2) {
      // Graphic (−2) / image (−3) object: its own colour and width → one synthesised symbol per (type, colour, width).
      const colour = stackIdxByNumber.get(o.col ?? -1);
      const widthUm = (o.lineWidth ?? 0) * (1000 / OCAD_UNITS_PER_MM);
      const key = `${o.otp}/${colour ?? "-"}/${widthUm}`;
      symbolIdx = graphicIdx.get(key);
      if (symbolIdx === undefined) {
        symbolIdx = symbols.length;
        graphicIdx.set(key, symbolIdx);
        const kind = kindOfObjectType(o.otp);
        let render: RenderSymbol | null = null;
        if (colour !== undefined) {
          const base = { id: `graphic:${key}`, code: "graphic", name: `Graphic ${kind}` };
          if (kind === "line" || kind === "rectangle") render = parseRenderSymbol({ type: "line", ...base, main: { colour, widthUm: Math.max(widthUm, 1) } });
          else if (kind === "area") render = parseRenderSymbol({ type: "area", ...base, fill: colour });
        }
        symbols.push({ code: "graphic", name: `Graphic ${kind}`, kind, origin: "graphic", hidden: false, render });
      }
      counts.graphicObjects++;
    } else {
      symbolIdx = symbolIdxBySymNum.get(o.sym);
      if (symbolIdx === undefined) {
        symbolIdx = missingIdx.get(o.sym);
        if (symbolIdx === undefined) {
          symbolIdx = symbols.length;
          missingIdx.set(o.sym, symbolIdx);
          symbols.push({ code: `${Math.floor(o.sym / 1000)}.${o.sym % 1000}`, name: "", kind: kindOfObjectType(o.otp), origin: "missing", hidden: false, render: null });
          warn("MISSING_SYMBOL", `objects reference symbol ${Math.floor(o.sym / 1000)}.${o.sym % 1000}, which is not in the symbol table`, 1, symbolIdx);
        }
        counts.missingSymbolObjects++;
      }
    }
    const coords = new Int32Array(n * 2);
    const flags = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      const c = o.coordinates[k];
      coords[k * 2] = c[0];
      coords[k * 2 + 1] = c[1];
      flags[k] = ocadFlags(c.xFlags ?? 0, c.yFlags ?? 0);
    }
    const obj: MapObjectInput = { symbolIdx, type: o.otp, sourceIndex: i, coords, flags };
    if (o.ang) obj.angleDeciDeg = o.ang;
    if (o.text) {
      obj.text = o.text;
      counts.texts++;
    }
    objects.push(obj);
    counts.coordinates += n;
  }
  counts.objects = objects.length;
  counts.symbols = symbols.length;
  rotateFromObjectAngles(symbols, objects);

  // Dropped parameter strings, recorded (02 §2.4).
  const templates = ocad.parameterStrings["8"]?.length ?? 0;
  if (templates) warn("TEMPLATES_DROPPED", `${templates} template(s) referenced by the map are not imported`, templates);
  const layout = ocad.parameterStrings["24"]?.length ?? 0;
  if (layout) warn("LAYOUT_OBJECTS_DROPPED", `${layout} layout object(s) not imported`, layout);
  // The reader drops symbol definitions it cannot parse with a warning of its
  // own; those are unsupported symbol types (§3.3), not reader noise.
  let readerWarningCount = 0;
  const readerWarnings: string[] = [];
  for (const w of Array.from(ocad.warnings ?? [])) {
    const text = w instanceof Error ? w.message : String(w);
    const dropped = READER_DROPPED_SYMBOL.exec(text);
    const unknown = READER_UNKNOWN_SYMBOL_TYPE.exec(text);
    if (dropped) {
      const n = Number(dropped[2]);
      warn("SYMBOL_TYPE_UNSUPPORTED", `${Math.floor(n / 1000)}.${n % 1000}: ${dropped[1]} symbol dropped by the reader`);
    } else if (unknown) warn("SYMBOL_TYPE_UNSUPPORTED", `symbol type ${unknown[1]} dropped by the reader`);
    else {
      readerWarningCount++;
      if (readerWarnings.length < READER_WARNING_TEXTS_MAX) readerWarnings.push(text);
    }
  }
  if (readerWarningCount) warn("READER_WARNING", "texts in the import report (readerWarnings)", readerWarningCount);

  const { georeferencing, mapScale, unresolvedCrs } = ocadGeoreferencing(ocad);
  if (unresolvedCrs) warn("CRS_UNRESOLVED", `coordinate reference system not mapped to EPSG: ${unresolvedCrs}`);
  const pp = pairs(ocad.parameterStrings["1026"]?.[0]);
  const L = num(pp.get("L")), B = num(pp.get("B")), R = num(pp.get("R")), T = num(pp.get("T"));
  const printWindow = L !== undefined && B !== undefined && R !== undefined && T !== undefined
    ? { scale: num(pp.get("a")), left: L, bottom: B, right: R, top: T }
    : null;
  const exportRectangles = (ocad.parameterStrings["26"] ?? []).flatMap((ps) => {
    const p = pairs(ps);
    const l = num(p.get("L")), b = num(p.get("B")), r = num(p.get("R")), t = num(p.get("T"));
    return l !== undefined && b !== undefined && r !== undefined && t !== undefined ? [{ name: ps._first ?? "", left: l, bottom: b, right: r, top: t }] : [];
  });

  const h = ocad.header;
  const header: Omit<MapDocumentHeaderInput, "bounds" | "strings" | "objects"> = {
    format: { version: 1, importer: opts.importer ?? OCAD_IMPORTER_VERSION },
    source: { kind: "ocad", version: [h.version, h.subVersion, h.subSubVersion].filter((v) => v !== undefined).join("."), hash: opts.fileHash, bytes: opts.fileBytes },
    unitsPerMm: OCAD_UNITS_PER_MM,
    mapScale,
    georeferencing,
    printWindow,
    exportRectangles,
    colours,
    symbols,
    warnings: [...warnings.values()],
  };
  const input: MapDocumentInput = { header, objects };
  return { input, counts, warnings: [...warnings.values()], warningDetails, readerWarnings, analysis: analyseDocumentInput(input) };
}
