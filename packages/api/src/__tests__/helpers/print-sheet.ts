/**
 * A sheet and a deterministic course on a map document, for the print
 * worker tests: what the corpus tool (`render/print-run.ts`, deleted in
 * E4a; docs/course-print.md §11) printed each map on.
 */
import { defaultMapAppearance, getPaperDimensions, mapDocument, type ControlDescription } from "@oxygen/shared";
import type { LayoutControlSource, LayoutCourseSource, LayoutTemplateSource } from "../../course-maps/resolve-layout.js";

/** Paper margin of the corpus sheet, mm. */
const PRINT_MARGIN_MM = 3;
/** Description cell of the corpus sheet, mm. */
const DESCRIPTION_CELL_MM = 5;

export interface PrintSheetOptions {
  /** ISO paper instead of the print window's own size (the frame = paper − margins). */
  paper?: { size: "A3" | "A4" | "A5"; orientation?: "portrait" | "landscape" };
  /** Print scale denominator; default the print window's, else the map scale. */
  printScale?: number;
  /** Window centre, paper mm y-up; default the print window's centre, else the bounds'. */
  centre?: { x: number; y: number };
}

export interface PrintSheetSpec {
  template: LayoutTemplateSource;
  /** Window centre, paper mm y-up. */
  centre: { x: number; y: number };
  mapScale: number;
  printScale: number;
  source: "print-window" | "bounds" | "override";
  paperName: string;
}

type HeaderLike = Pick<mapDocument.MapDocumentHeader, "printWindow" | "bounds" | "unitsPerMm" | "mapScale">;

/**
 * The sheet a corpus page is printed on: the OCAD print window at its
 * print scale on a custom sheet of frame + margins (what OCAD prints),
 * else A4 at the map scale on the object bounds' centre, then the
 * overrides (`--paper`, `--print-scale`, `--centre`).
 */
export function printSheetFor(header: HeaderLike, opts: PrintSheetOptions = {}): PrintSheetSpec {
  const mapScale = header.mapScale;
  const pw = header.printWindow && header.printWindow.right > header.printWindow.left && header.printWindow.top > header.printWindow.bottom ? header.printWindow : null;
  const k = 1 / header.unitsPerMm;
  const b = header.bounds;
  let centre = pw ? { x: (pw.left + pw.right) / 2, y: (pw.bottom + pw.top) / 2 } : { x: ((b.minX + b.maxX) / 2) * k, y: ((b.minY + b.maxY) / 2) * k };
  let printScale = Math.round(pw?.scale ?? mapScale);
  let source: PrintSheetSpec["source"] = pw ? "print-window" : "bounds";
  let paper: { paper: string; orientation: string; width: number | null; height: number | null; name: string };
  if (opts.paper || !pw) {
    const size = opts.paper?.size ?? "A4";
    const wide = (b.maxX - b.minX) > (b.maxY - b.minY);
    const orientation = opts.paper?.orientation ?? (pw ? (pw.right - pw.left > pw.top - pw.bottom ? "landscape" : "portrait") : wide ? "landscape" : "portrait");
    paper = { paper: size, orientation, width: null, height: null, name: `${size} ${orientation}` };
  } else {
    // The print window enlarged to the print scale is the frame, the sheet rounded up to whole mm:
    // a fractional page puts PDF raster and oracle up to half a pixel apart at every edge.
    const f = mapScale / printScale;
    const mm = (v: number) => Math.ceil(v - 1e-6);
    const w = mm((pw.right - pw.left) * f + 2 * PRINT_MARGIN_MM), h = mm((pw.top - pw.bottom) * f + 2 * PRINT_MARGIN_MM);
    paper = { paper: "custom", orientation: w > h ? "landscape" : "portrait", width: w, height: h, name: `custom ${w} × ${h}` };
  }
  if (opts.printScale) printScale = opts.printScale;
  if (opts.centre) centre = opts.centre;
  if (opts.paper || opts.printScale || opts.centre) source = "override";
  const dims = getPaperDimensions(paper.paper as "A4", paper.orientation as "portrait", paper.width !== null ? { width: paper.width, height: paper.height! } : undefined);
  const frame = { x: PRINT_MARGIN_MM, y: PRINT_MARGIN_MM, width: round3(dims.width - 2 * PRINT_MARGIN_MM), height: round3(dims.height - 2 * PRINT_MARGIN_MM) };
  const blockW = 8 * DESCRIPTION_CELL_MM;
  const description = {
    // Top right of the frame when the frame has room for the block and some map beside it.
    visible: frame.width >= 100 && frame.height >= 80,
    x: round3(frame.x + frame.width - blockW - 2),
    y: frame.y + 2,
    cellSizeMm: DESCRIPTION_CELL_MM,
  };
  return {
    template: {
      paper: paper.paper,
      orientation: paper.orientation,
      paperWidthMm: paper.width,
      paperHeightMm: paper.height,
      printScale,
      settings: { printMarginMm: PRINT_MARGIN_MM, mapFrame: frame, description, appearance: defaultMapAppearance },
      objects: [],
    },
    centre,
    mapScale,
    printScale,
    source,
    paperName: paper.name,
  };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Site positions as fractions of the window's half extents (start, four controls, finish). */
const SITES: Array<{ fx: number; fy: number; description?: ControlDescription }> = [
  { fx: -0.6, fy: -0.55 },
  { fx: -0.25, fy: 0.5, description: { d: "1.010" } },
  { fx: 0.45, fy: 0.45, description: { d: "2.004" } },
  { fx: 0.55, fy: -0.2, description: { d: "1.010", s: "1,5" } },
  { fx: 0.05, fy: -0.5, description: { d: "2.004" } },
  { fx: -0.3, fy: -0.1 },
];

/**
 * A deterministic course on a window: start, controls 31–34, finish at
 * fixed fractions of the window (paper mm, y-up, axis-aligned — a tilt of
 * a few degrees keeps them inside), with the GeoJSON the legacy layout
 * reads its start, finish and leg ends from. No legs and no cuts in the
 * GeoJSON: both pages derive their straight legs; the vector page cuts
 * them around document features (`size-aware-cuts`).
 */
export function syntheticCourse(centre: { x: number; y: number }, window: { width: number; height: number }, mapScale: number): LayoutCourseSource {
  const at = (s: (typeof SITES)[number]) => ({ x: round3(centre.x + (s.fx * window.width) / 2), y: round3(centre.y + (s.fy * window.height) / 2) });
  const pts = SITES.map(at);
  let lengthMm = 0;
  for (let i = 1; i < pts.length; i++) lengthMm += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const controls: LayoutControlSource[] = SITES.slice(1, -1).map((s, i) => ({
    id: `c${31 + i}`,
    seq: i + 1,
    codes: String(31 + i),
    xpos: pts[i + 1].x,
    ypos: pts[i + 1].y,
    description: s.description,
  }));
  const point = (symbolType: "start" | "finish", p: { x: number; y: number }) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [p.x, p.y] },
    properties: { symbolType, id: symbolType, code: symbolType === "start" ? "S" : "F" },
  });
  return {
    name: "Corpus",
    lengthM: Math.round((lengthMm * mapScale) / 1000 / 10) * 10,
    climbM: 0,
    orderMode: "ordered",
    classes: [{ name: "H21" }],
    controls,
    geometry: { type: "FeatureCollection", features: [point("start", pts[0]), point("finish", pts[pts.length - 1])] },
  };
}
