/**
 * Synthetic map documents for the terrain graph tests: ISOM symbols with
 * canonical matches and library definitions, geometry given in paper mm.
 */

import { OBJECT_TYPE, decodeMapDocument, encodeMapDocument, type DocumentSymbolInput, type MapDocument, type MapObjectInput } from "../../../map-document/index.js";
import { SYMBOL_LIBRARY_VERSION, materialiseLibrary } from "../../../symbol-library/index.js";

const lib = materialiseLibrary("ISOM2017-2");

function render(entryId: string) {
  const i = lib.library.entries.findIndex((e) => e.id === entryId);
  if (i < 0) throw new Error(`no library entry ${entryId}`);
  return lib.symbols[i];
}

const matched = (entryId: string, kind: DocumentSymbolInput["kind"], state: "auto" | "suggested" = "auto", hidden = false): DocumentSymbolInput => {
  const code = entryId.split(":")[1];
  return {
    code: `${code}.0`,
    name: code,
    kind,
    hidden,
    render: render(entryId),
    match: { canonicalId: entryId, method: "explicit", state, confidence: 1, libraryVersion: SYMBOL_LIBRARY_VERSION },
  };
};

/** Symbol indices of `SYMBOLS`. */
export const S = {
  contour: 0,
  index: 1,
  form: 2,
  tick: 3,
  formTick: 4,
  cliffTagged: 5,
  cliff: 6,
  water: 7,
  vegetation: 8,
  hiddenContour: 9,
  road: 10,
  suggestedCliff: 11,
  contourAsArea: 12,
  sourceOnly: 13,
  course: 14,
} as const;

export const SYMBOLS: DocumentSymbolInput[] = [
  matched("ISOM2017-2:101", "line"),
  matched("ISOM2017-2:102", "line"),
  matched("ISOM2017-2:103", "line"),
  matched("ISOM2017-2:101.b", "point"),
  matched("ISOM2017-2:103.b", "point"),
  matched("ISOM2017-2:201", "line"),
  matched("ISOM2017-2:202", "line"),
  matched("ISOM2017-2:301", "area"),
  matched("ISOM2017-2:406", "area"),
  matched("ISOM2017-2:101", "line", "auto", true),
  matched("ISOM2017-2:502", "line"),
  { ...matched("ISOM2017-2:202.b", "line", "suggested") },
  { ...matched("ISOM2017-2:101", "area"), render: render("ISOM2017-2:406") },
  { code: "405.0", name: "Unmatched forest", kind: "area", render: render("ISOM2017-2:406") },
  { code: "701.0", name: "Start", kind: "point", render: render("ISOM2017-2:101.b") },
];

export interface Obj {
  sym: number;
  /** Paper mm, x right, y up. */
  coords: number[];
  flags?: number[];
  type?: number;
  angleDeciDeg?: number;
}

const typeOf = (sym: number): number => {
  const k = SYMBOLS[sym].kind;
  return k === "point" ? OBJECT_TYPE.point : k === "area" ? OBJECT_TYPE.area : OBJECT_TYPE.line;
};

/** A document at `mapScale` (OCAD units, 0.01 mm) holding `objects` in order. */
export function syntheticDoc(objects: Obj[], mapScale = 15000): MapDocument {
  const input: MapObjectInput[] = objects.map((o, i) => ({
    symbolIdx: o.sym,
    type: o.type ?? typeOf(o.sym),
    angleDeciDeg: o.angleDeciDeg,
    sourceIndex: i,
    coords: o.coords.map((v) => Math.round(v * 100)),
    flags: o.flags ?? new Array(o.coords.length / 2).fill(0),
  }));
  return decodeMapDocument(
    encodeMapDocument({
      header: {
        format: { version: 1, importer: "terrain-test" },
        source: { kind: "ocad", version: "2018", hash: "00".repeat(32), bytes: 1 },
        unitsPerMm: 100,
        mapScale,
        library: { id: "ISOM2017-2", version: SYMBOL_LIBRARY_VERSION },
        georeferencing: { crs: null, paperOrigin: { x: 0, y: 0 }, gridRotationDeg: 0 },
        colours: lib.colours,
        symbols: SYMBOLS,
      },
      objects: input,
    }),
  );
}

/** A closed ring (first point repeated last), counter-clockwise. */
export function ring(cx: number, cy: number, r: number, n = 48): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((i % n) / n) * 2 * Math.PI;
    out.push(+(cx + r * Math.cos(a)).toFixed(2), +(cy + r * Math.sin(a)).toFixed(2));
  }
  return out;
}

/** A rectangle ring, counter-clockwise, closed. */
export function rect(x0: number, y0: number, x1: number, y1: number): number[] {
  return [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];
}

/** A straight line sampled every `step` mm (so end tangents are well defined). */
export function line(x0: number, y0: number, x1: number, y1: number, step = 1): number[] {
  const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / step));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(+(x0 + ((x1 - x0) * i) / n).toFixed(2), +(y0 + ((y1 - y0) * i) / n).toFixed(2));
  return out;
}

/**
 * `objects` behind a mapped area (a vegetation rectangle, source 0). The
 * mask's grid covers only the contours' box plus 5.5 mm (map-terrain.md
 * §2.3), so by default the area is that box grown by 5 mm: every contour
 * end lies 5 mm inside it. Pass `area` to put the frame elsewhere.
 */
export function mapped(objects: Obj[], area?: [number, number, number, number]): Obj[] {
  if (!area) {
    const xs: number[] = [], ys: number[] = [];
    for (const o of objects) {
      if (o.sym !== S.contour && o.sym !== S.index) continue;
      for (let i = 0; i < o.coords.length; i += 2) {
        xs.push(o.coords[i]);
        ys.push(o.coords[i + 1]);
      }
    }
    area = [Math.min(...xs) - 5, Math.min(...ys) - 5, Math.max(...xs) + 5, Math.max(...ys) + 5];
  }
  return [{ sym: S.vegetation, coords: rect(...area) }, ...objects];
}

/** A ring cut into two open halves at angles 0 and π (so the halves continue each other). */
export function halves(cx: number, cy: number, r: number): [number[], number[]] {
  const full = ring(cx, cy, r, 48);
  return [full.slice(0, 50), full.slice(48)];
}
