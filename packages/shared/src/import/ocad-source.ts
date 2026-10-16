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
import { OBJECT_TYPE } from "../map-document/header.js";
import type { DocumentColour, DocumentSymbolInput, DocumentWarning, Georeferencing, MapDocumentHeaderInput } from "../map-document/header.js";

/** OCAD coordinates are 1/100 mm. */
export const OCAD_UNITS_PER_MM = 100;
export const OCAD_IMPORTER_VERSION = "ocad-2";

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

export function ocadGeoreferencing(ocad: OcadFileLike): { georeferencing: Georeferencing; mapScale: number } {
  const sp = pairs(ocad.parameterStrings["1039"]?.[0]);
  const mapScale = num(sp.get("m")) ?? 15000;
  let crs: Georeferencing["crs"] = null;
  try {
    const c = ocad.getCrs?.();
    if (c?.code) crs = { authority: c.catalog ?? "EPSG", code: c.code, name: c.name ?? "" };
  } catch {
    crs = null;
  }
  const x = num(sp.get("x")), y = num(sp.get("y"));
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
  const d = num(sp.get("d"));
  if (d !== undefined) georeferencing.declinationDeg = d;
  const r = sp.get("r");
  if (r !== undefined) georeferencing.realWorldEnabled = r === "1";
  const gid = num(sp.get("i"));
  if (gid !== undefined) georeferencing.sourceGridId = gid;
  return { georeferencing, mapScale };
}

export function ocadToDocumentInput(ocad: OcadFileLike, opts: OcadSourceOptions): OcadSourceResult {
  const warnings = new Map<string, DocumentWarning>();
  const warn = (code: string, message?: string, count = 1) => {
    const w = warnings.get(code);
    if (w) w.count += count;
    else warnings.set(code, { code, count, message });
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
  const conversionCtx = { colourIndex: (n: number) => stackIdxByNumber.get(n), symbolByNumber: (n: number) => defBySymNum.get(n) };
  let symbolsRendered = 0, symbolsUnrendered = 0;
  for (let i = 0; i < ocad.symbols.length; i++) {
    const s = ocad.symbols[i];
    let render: RenderSymbol | null;
    if (opts.renderFor) {
      render = opts.renderFor(s);
    } else {
      const conv = ocadSymbolToRender(s, conversionCtx);
      render = conv.render;
      for (const w of conv.warnings) warn(w.code, w.message);
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
    else warn("DUPLICATE_SYMBOL_NUMBER", `symbol ${s.number} defined more than once; first definition used`);
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
          warn("MISSING_SYMBOL", `objects reference symbol ${Math.floor(o.sym / 1000)}.${o.sym % 1000}, which is not in the symbol table`);
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

  // Dropped parameter strings, recorded (02 §2.4).
  const templates = ocad.parameterStrings["8"]?.length ?? 0;
  if (templates) warn("TEMPLATES_DROPPED", `${templates} template(s) referenced by the map are not imported`, templates);
  const layout = ocad.parameterStrings["24"]?.length ?? 0;
  if (layout) warn("LAYOUT_OBJECTS_DROPPED", `${layout} layout object(s) not imported`, layout);
  const readerWarnings = ocad.warnings?.length ?? 0;
  if (readerWarnings) warn("READER_WARNING", "see the reader's warning list", readerWarnings);

  const { georeferencing, mapScale } = ocadGeoreferencing(ocad);
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
    source: { kind: "ocad", version: [h.version, h.subVersion, h.subSubVersion].filter((v) => v !== undefined).join("."), name: opts.fileName, hash: opts.fileHash, bytes: opts.fileBytes },
    unitsPerMm: OCAD_UNITS_PER_MM,
    mapScale,
    georeferencing,
    printWindow,
    exportRectangles,
    colours,
    symbols,
    warnings: [...warnings.values()],
  };
  return { input: { header, objects }, counts, warnings: [...warnings.values()] };
}
