/**
 * Authoring helpers for library entries. They only build plain objects in
 * the `LibraryRender` shape (y-up glyph-local µm, palette ids as colours);
 * nothing here is needed at render time. See docs/map-symbols.md §4.
 */

import type { LibraryEntryInput, LibraryRender } from "./schema.js";

type Render = LibraryRender;
type LineRender = Extract<Render, { type: "line" }>;
type AreaRender = Extract<Render, { type: "area" }>;
type PointRender = Extract<Render, { type: "point" }>;
type Glyph = NonNullable<LineRender["glyphs"]>[number]["glyph"];
type Part = Glyph["parts"][number];
type Placement = NonNullable<LineRender["glyphs"]>[number]["placement"];
type Stroke = NonNullable<LineRender["main"]>;
type Dash = NonNullable<Stroke["dash"]>;
type Border = NonNullable<NonNullable<LineRender["borders"]>["left"]>;

// ---- glyph parts ---------------------------------------------------------

/** Polyline stroke; `coords` are x,y pairs. */
export function stroke(colour: string, widthUm: number, coords: number[], opts: { cap?: Part["cap"]; join?: Part["join"]; closed?: boolean; flags?: number[] } = {}): Part {
  const geometry: NonNullable<Part["geometry"]> = { coords };
  if (opts.closed) geometry.closed = true;
  if (opts.flags) geometry.flags = opts.flags;
  const p: Part = { kind: "stroke", colour, widthUm, geometry };
  if (opts.cap) p.cap = opts.cap;
  if (opts.join) p.join = opts.join;
  return p;
}

/** Filled polygon; closed implicitly. */
export function fillPart(colour: string, coords: number[], flags?: number[]): Part {
  const geometry: NonNullable<Part["geometry"]> = { coords, closed: true };
  if (flags) geometry.flags = flags;
  return { kind: "fill", colour, geometry };
}

export function disc(colour: string, diameterUm: number, cx = 0, cy = 0): Part {
  const p: Part = { kind: "disc", colour, diameterUm };
  if (cx) p.cx = cx;
  if (cy) p.cy = cy;
  return p;
}

/** Ring by its *outer* diameter (spec "(CC)" + width). */
export function ring(colour: string, outerDiameterUm: number, widthUm: number, cx = 0, cy = 0): Part {
  const p: Part = { kind: "ring", colour, diameterUm: outerDiameterUm, widthUm };
  if (cx) p.cx = cx;
  if (cy) p.cy = cy;
  return p;
}

/** Ring stated centre-to-centre, as the specs do. */
export function ringCC(colour: string, ccDiameterUm: number, widthUm: number, cx = 0, cy = 0): Part {
  return ring(colour, ccDiameterUm + widthUm, widthUm, cx, cy);
}

/** Vertical tick from (x, y0) to (x, y1). */
export function tick(colour: string, widthUm: number, y0: number, y1: number, x = 0): Part {
  return stroke(colour, widthUm, [x, y0, x, y1]);
}

/** Regular polygon fill, radius to the vertices, first vertex at `startDeg`. */
export function polygon(colour: string, sides: number, radiusUm: number, startDeg = 90): Part {
  const coords: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = ((startDeg + (360 * i) / sides) * Math.PI) / 180;
    coords.push(Math.round(radiusUm * Math.cos(a)), Math.round(radiusUm * Math.sin(a)));
  }
  return fillPart(colour, coords);
}

/** Equilateral triangle by side length, apex up, centroid at the origin. */
export function triangle(colour: string, sideUm: number): Part {
  const h = (sideUm * Math.sqrt(3)) / 2;
  return fillPart(colour, [-sideUm / 2, -h / 3, sideUm / 2, -h / 3, 0, (2 * h) / 3].map(Math.round));
}

/** Square by side, centred. */
export function square(colour: string, sideUm: number): Part {
  const s = sideUm / 2;
  return fillPart(colour, [-s, -s, s, -s, s, s, -s, s]);
}

/** "x" of two strokes, arms of `armUm` from the centre. */
export function cross(colour: string, widthUm: number, armUm: number): Part[] {
  const a = Math.round(armUm / Math.SQRT2);
  return [stroke(colour, widthUm, [-a, -a, a, a]), stroke(colour, widthUm, [-a, a, a, -a])];
}

/** "+" of two strokes, arms of `armUm` from the centre. */
export function plus(colour: string, widthUm: number, armUm: number): Part[] {
  return [stroke(colour, widthUm, [-armUm, 0, armUm, 0]), stroke(colour, widthUm, [0, -armUm, 0, armUm])];
}

/** Polyline approximation of an elliptical arc, `fromDeg` → `toDeg` counter-clockwise, y-up. */
export function arcCoords(cx: number, cy: number, rx: number, ry: number, fromDeg: number, toDeg: number, steps = 8): number[] {
  const out: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((fromDeg + ((toDeg - fromDeg) * i) / steps) * Math.PI) / 180;
    out.push(Math.round(cx + rx * Math.cos(a)), Math.round(cy + ry * Math.sin(a)));
  }
  return out;
}

/** Half disc (flat side on the x axis) on the `-y` side — the specs' "half dot" on the lower side. */
export function halfDisc(colour: string, diameterUm: number): Part {
  return fillPart(colour, arcCoords(0, 0, diameterUm / 2, diameterUm / 2, 180, 360, 10));
}

export function glyph(parts: Part | Part[], rotatable = true): Glyph {
  return { parts: Array.isArray(parts) ? parts : [parts], rotatable };
}

// ---- strokes, dashes, borders --------------------------------------------

export function solid(colour: string, widthUm: number, opts: Partial<Omit<Stroke, "colour" | "widthUm">> = {}): Stroke {
  return { colour, widthUm, ...opts };
}

/** OCAD-fitted dash: dashes stretch/shrink so sections start and end with a full dash. */
export function dashOcad(dashUm: number, gapUm: number, opts: Partial<Omit<Dash, "layout" | "dashUm" | "gapUm">> = {}): Dash {
  return { layout: "ocad", dashUm, gapUm, ...opts };
}

/** OMAP-fitted dash. */
export function dashOmap(dashUm: number, gapUm: number, opts: Partial<Omit<Dash, "layout" | "dashUm" | "gapUm">> = {}): Dash {
  return { layout: "omap", dashUm, gapUm, ...opts };
}

export function dashed(colour: string, widthUm: number, dashUm: number, gapUm: number, opts: Partial<Omit<Stroke, "colour" | "widthUm" | "dash">> & { dash?: Partial<Dash> } = {}): Stroke {
  const { dash, ...rest } = opts;
  return { colour, widthUm, dash: dashOcad(dashUm, gapUm, dash), ...rest };
}

export function border(colour: string, widthUm: number, shiftUm: number, dash?: Dash): Border {
  return dash ? { colour, widthUm, shiftUm, dash } : { colour, widthUm, shiftUm };
}

/** Symmetric double line: two borders `shiftUm` either side of the axis, optional infill. */
export function doubleLine(edge: Border, backgroundColour?: string, backgroundWidthUm?: number): NonNullable<LineRender["borders"]> {
  const b: NonNullable<LineRender["borders"]> = { left: edge, right: { ...edge } };
  if (backgroundColour) b.backgroundColour = backgroundColour;
  if (backgroundWidthUm) b.backgroundWidthUm = backgroundWidthUm;
  return b;
}

// ---- placements ----------------------------------------------------------

export function spaced(distanceUm: number, opts: Partial<Omit<Extract<Placement, { at: "spaced" }>, "at" | "distanceUm">> = {}): Placement {
  return { at: "spaced", distanceUm, ...opts };
}
export const atStart: Placement = { at: "start" };
export const atEnd: Placement = { at: "end" };
export const atGapCentres: Placement = { at: "gapCentres" };
export const atDashCentres: Placement = { at: "dashCentres" };
export const atDashPoints: Placement = { at: "dashPoints" };
export const atCorners = (ignoreEnds = false): Placement => (ignoreEnds ? { at: "corners", ignoreEnds: true } : { at: "corners" });

export function placed(g: Glyph, placement: Placement, scaleAtCorners = false): NonNullable<LineRender["glyphs"]>[number] {
  return scaleAtCorners ? { glyph: g, placement, scaleAtCorners: true } : { glyph: g, placement };
}

// ---- symbol bodies -------------------------------------------------------

export function line(body: Omit<LineRender, "type">): LineRender {
  return { type: "line", ...body };
}
export function area(body: Omit<AreaRender, "type">): AreaRender {
  return { type: "area", ...body };
}
export function point(parts: Part | Part[], orientation: "north" | "object" = "north"): PointRender {
  return { type: "point", glyph: glyph(parts, orientation === "object"), orientation };
}

export function hatch(colour: string, widthUm: number, spacingUm: number, angleDeg: number, opts: { offsetUm?: number; rotate?: "always" | "manual" | "never" } = {}): NonNullable<AreaRender["hatches"]>[number] {
  return { colour, widthUm, spacingUm, angleDeg, ...opts };
}

/** Regular grid of one glyph; `angleDeg` 45 for the specs' diagonal dot grids. */
export function pattern(
  g: Glyph,
  cellUm: number | { w: number; h: number },
  opts: Partial<Omit<NonNullable<AreaRender["patterns"]>[number], "glyph" | "cellWidthUm" | "cellHeightUm">> = {},
): NonNullable<AreaRender["patterns"]>[number] {
  const w = typeof cellUm === "number" ? cellUm : cellUm.w;
  const h = typeof cellUm === "number" ? cellUm : cellUm.h;
  return { glyph: g, cellWidthUm: w, cellHeightUm: h, ...opts };
}

// ---- entries -------------------------------------------------------------

export interface EntryOpts {
  variant?: string;
  description?: string;
  sv?: string;
  purpleRole?: "lower" | "upper";
  minimum?: NonNullable<LibraryEntryInput["minimum"]>;
  footprintM?: number;
  aliases?: LibraryEntryInput["aliases"];
  notes?: string;
  /** Overrides the library's default citation. */
  source?: string;
}

export interface Author {
  (code: string, en: string, specType: LibraryEntryInput["specType"], render: Render, opts?: EntryOpts): LibraryEntryInput;
}

/** Bind the library id and default citation once per library. */
export function authorFor(libraryId: string, citation: string): Author {
  return (code, en, specType, render, opts = {}) => {
    const entry: LibraryEntryInput = {
      id: `${libraryId}:${code}${opts.variant ? `.${opts.variant}` : ""}`,
      code,
      variant: opts.variant ?? null,
      name: opts.sv ? { en, sv: opts.sv } : { en },
      specType,
      purpleRole: opts.purpleRole ?? null,
      orientation: render.type === "point" ? render.orientation ?? "north" : null,
      aliases: opts.aliases ?? [],
      render,
      source: opts.source ?? `${citation}, symbol ${code}`,
    };
    if (opts.description) entry.description = opts.description;
    if (opts.minimum) entry.minimum = opts.minimum;
    if (opts.footprintM !== undefined) entry.footprintM = opts.footprintM;
    if (opts.notes) entry.notes = opts.notes;
    return entry;
  };
}
