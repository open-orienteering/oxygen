/**
 * IOF colour-stack classification for course overprinting.
 *
 * ISOM / ISSprOM / ISSkiOM / ISMTBOM place "lower purple" (course
 * circles, legs, start, finish) under a profile-specific set of map
 * colours so those features stay sharp through the purple. Digital
 * printers simulate that by colour order, not blend modes — see IOF
 * Printing and Colour Definitions rev. 4, chapter 7.
 *
 * This module classifies each OCAD colour as "above" or "below" that
 * lower-purple slot from its CMYK values, which symbol geometry types
 * use it, and the active profile, then rewrites `renderOrder` so
 * `ocadToSvg`'s `fromColor` / `toColor` filters can emit an ink layer
 * (above) and a full composite. Relative order inside each group is
 * preserved.
 */

import type {
  ColorProfile,
  ColorStackOverrides,
  ResolvedColorProfile,
} from "@oxygen/shared";

export type { ColorProfile, ColorStackOverrides, ResolvedColorProfile };

export interface StackColor {
  number: number;
  cmyk: number[];
  name?: string;
  renderOrder: number;
}

export interface StackSymbolElement {
  color?: number;
}

export interface StackSymbol {
  type?: number;
  lineColor?: number;
  frColor?: number;
  fillColor?: number;
  hatchColor?: number;
  fontColor?: number;
  elements?: StackSymbolElement[];
  doubleLine?: {
    dblFillColor?: number;
    dblLeftColor?: number;
    dblRightColor?: number;
  };
}

export interface StackOcadObject {
  sym?: number;
}

export interface StackOcadFile {
  colors: Array<StackColor | undefined | null>;
  symbols: StackSymbol[];
  objects?: StackOcadObject[];
}

export interface ColorUsage {
  line: boolean;
  point: boolean;
  area: boolean;
  text: boolean;
}

export type ColorStackResolvedBy =
  | "explicit"
  | "file-colour"
  | "scale"
  | "default";

export interface ColorStackResult {
  /** First renderOrder of the below group (= ink layer `toColor + 1`). */
  boundary: number;
  /** Colour numbers classified above lower purple (low renderOrder). */
  above: number[];
  /** Colour numbers classified below lower purple (high renderOrder). */
  below: number[];
  warnings: string[];
  /** Rule set actually applied (never `auto`). */
  resolvedProfile: ResolvedColorProfile;
  /** How `resolvedProfile` / the boundary was chosen. */
  resolvedBy: ColorStackResolvedBy;
}

export interface ApplyIofColorStackOpts {
  profile?: ColorProfile;
  overrides?: ColorStackOverrides;
  /** Map scale denominator (e.g. 15000). Used when profile is `auto`. */
  scale?: number | null;
}

type UsageMap = Map<number, ColorUsage>;

/** ISOM 601.x magnetic north lines — filtered from the ink layer when
 * `northLinesBelow` is on (colour shared with streams). */
export const MERIDIAN_SYMBOL_BASE = 601;

const LOWER_PURPLE_NAME = /lower\s*purple|undre\s*lila/i;

function emptyUsage(): ColorUsage {
  return { line: false, point: false, area: false, text: false };
}

function mark(
  usage: UsageMap,
  colorNumber: number | undefined | null,
  kind: keyof ColorUsage,
): void {
  if (colorNumber == null || !Number.isFinite(colorNumber) || colorNumber < 0) {
    return;
  }
  let entry = usage.get(colorNumber);
  if (!entry) {
    entry = emptyUsage();
    usage.set(colorNumber, entry);
  }
  entry[kind] = true;
}

function collectUsage(symbols: StackSymbol[]): UsageMap {
  const usage: UsageMap = new Map();
  for (const symbol of symbols) {
    const type = symbol.type;
    if (type === 1) {
      for (const element of symbol.elements ?? []) {
        mark(usage, element.color, "point");
      }
    } else if (type === 2) {
      mark(usage, symbol.lineColor, "line");
      mark(usage, symbol.frColor, "line");
      const dbl = symbol.doubleLine;
      if (dbl) {
        mark(usage, dbl.dblFillColor, "line");
        mark(usage, dbl.dblLeftColor, "line");
        mark(usage, dbl.dblRightColor, "line");
      }
      for (const element of symbol.elements ?? []) {
        mark(usage, element.color, "line");
      }
    } else if (type === 3) {
      mark(usage, symbol.fillColor, "area");
      mark(usage, symbol.hatchColor, "area");
      for (const element of symbol.elements ?? []) {
        mark(usage, element.color, "area");
      }
    } else if (type === 4) {
      mark(usage, symbol.fontColor, "text");
    }
  }
  return usage;
}

function cmyk(color: StackColor): [number, number, number, number] {
  const [c = 0, m = 0, y = 0, k = 0] = color.cmyk ?? [];
  return [Number(c) || 0, Number(m) || 0, Number(y) || 0, Number(k) || 0];
}

function isBlack100(c: number, m: number, y: number, k: number): boolean {
  return k >= 90 && c <= 15 && m <= 15 && y <= 15;
}

function isBlue100(c: number, m: number, y: number, k: number): boolean {
  return c >= 90 && m <= 20 && y <= 10 && k <= 10;
}

function isBrown100(c: number, m: number, y: number, k: number): boolean {
  // Covers ISOM 0/56/100/18 and ISSprOM 25/75/100/0.
  return y >= 90 && m >= 45 && c <= 40 && k <= 30;
}

function isWhite(c: number, m: number, y: number, k: number): boolean {
  return c <= 1 && m <= 1 && y <= 1 && k <= 1;
}

function isGreen100(c: number, m: number, y: number, k: number): boolean {
  return c >= 70 && y >= 85 && m <= 20 && k <= 40;
}

/** Ski-O track green 91/0/83/0 (and nearby). */
function isSkiOGreen(c: number, m: number, y: number, k: number): boolean {
  return c >= 80 && y >= 70 && m <= 15 && k <= 15;
}

function isPurple100(c: number, m: number, y: number, k: number): boolean {
  // Full course purple 35/85/0/0 — never "above".
  return m >= 70 && c >= 20 && c <= 50 && y <= 15 && k <= 10;
}

/** Purple 50 % area (18/43/0/0) — above lower purple in ISSprOM / ISMTBOM. */
function isPurple50(c: number, m: number, y: number, k: number): boolean {
  return (
    c >= 10 &&
    c <= 30 &&
    m >= 30 &&
    m <= 55 &&
    y <= 15 &&
    k <= 10 &&
    !isPurple100(c, m, y, k)
  );
}

/**
 * Decide whether a colour belongs above the lower-purple slot under the
 * given resolved profile.
 */
export function isAboveLowerPurple(
  color: StackColor,
  usage: ColorUsage | undefined,
  profile: ResolvedColorProfile = "isom",
): boolean {
  const [c, m, y, k] = cmyk(color);
  const u = usage ?? emptyUsage();
  const usedByLinePointText = u.line || u.point || u.text;
  const usedByLinePoint = u.line || u.point;
  const usedOnlyByPoint = u.point && !u.line && !u.area && !u.text;

  // Full course purple is the slot we insert — never ink.
  if (isPurple100(c, m, y, k)) return false;

  if (isBlack100(c, m, y, k) && usedByLinePointText) return true;
  if (isWhite(c, m, y, k) && usedByLinePoint) return true;

  if (profile === "isom") {
    if (isBlue100(c, m, y, k) && usedByLinePoint) return true;
    if (isBrown100(c, m, y, k) && usedByLinePoint) return true;
    if (isGreen100(c, m, y, k) && usedOnlyByPoint) return true;
    return false;
  }

  if (profile === "issprom") {
    // Brown and blue 100 % sit BELOW lower purple in ISSprOM.
    if (isGreen100(c, m, y, k) && usedOnlyByPoint) return true;
    if (isPurple50(c, m, y, k) && u.area) return true;
    return false;
  }

  if (profile === "isskiom") {
    if (isBlue100(c, m, y, k) && usedByLinePoint) return true;
    // Ski-O green track colour (line) and green 100 % points.
    if ((isGreen100(c, m, y, k) || isSkiOGreen(c, m, y, k)) && usedByLinePoint) {
      return true;
    }
    return false;
  }

  // ismtbom
  if (isBlue100(c, m, y, k) && usedByLinePoint) return true;
  if (isGreen100(c, m, y, k) && usedOnlyByPoint) return true;
  if (isPurple50(c, m, y, k) && u.area) return true;
  return false;
}

function definedColors(file: StackOcadFile): StackColor[] {
  const out: StackColor[] = [];
  for (const color of file.colors) {
    if (color && Number.isFinite(color.number)) out.push(color);
  }
  // Preserve the file's original top-to-bottom order.
  out.sort((a, b) => a.renderOrder - b.renderOrder);
  return out;
}

function findLowerPurpleColour(colors: StackColor[]): StackColor | null {
  for (const color of colors) {
    if (color.name && LOWER_PURPLE_NAME.test(color.name)) return color;
  }
  return null;
}

/**
 * Resolve `auto` → a concrete profile. When a "Lower purple" colour is
 * present the caller should use file-order stacking instead; this helper
 * still returns a profile for logging / UI.
 */
export function resolveColorProfile(
  profile: ColorProfile,
  scale: number | null | undefined,
): { resolvedProfile: ResolvedColorProfile; resolvedBy: ColorStackResolvedBy } {
  if (profile !== "auto") {
    return { resolvedProfile: profile, resolvedBy: "explicit" };
  }
  if (scale != null && Number.isFinite(scale) && scale > 0 && scale <= 5000) {
    return { resolvedProfile: "issprom", resolvedBy: "scale" };
  }
  return { resolvedProfile: "isom", resolvedBy: scale != null ? "scale" : "default" };
}

function applyOverrides(
  above: StackColor[],
  below: StackColor[],
  overrides: ColorStackOverrides | undefined,
): { above: StackColor[]; below: StackColor[] } {
  if (!overrides) return { above, below };
  const forceAbove = new Set(overrides.above ?? []);
  const forceBelow = new Set(overrides.below ?? []);
  if (forceAbove.size === 0 && forceBelow.size === 0) return { above, below };

  const byNumber = new Map<number, StackColor>();
  for (const c of above) byNumber.set(c.number, c);
  for (const c of below) byNumber.set(c.number, c);

  const nextAbove: StackColor[] = [];
  const nextBelow: StackColor[] = [];
  const seen = new Set<number>();

  // Preserve relative order: walk original above then below.
  for (const c of [...above, ...below]) {
    if (seen.has(c.number)) continue;
    seen.add(c.number);
    if (forceBelow.has(c.number)) nextBelow.push(c);
    else if (forceAbove.has(c.number)) nextAbove.push(c);
    else if (above.includes(c)) nextAbove.push(c);
    else nextBelow.push(c);
  }
  // Colours only mentioned in overrides that weren't in the file — ignore.
  void byNumber;
  return { above: nextAbove, below: nextBelow };
}

function rewriteOrders(above: StackColor[], below: StackColor[]): number {
  let order = 0;
  for (const color of above) {
    color.renderOrder = order++;
  }
  const boundary = order;
  for (const color of below) {
    color.renderOrder = order++;
  }
  return boundary;
}

/**
 * Classify colours and rewrite `renderOrder` in place so indices
 * `0..boundary-1` are the ink layer (above lower purple) and
 * `boundary..n-1` are everything else.
 *
 * When nothing classifies as above, `boundary` is 0 and the ink layer
 * is empty — callers degrade to a single composite without stacking.
 */
export function applyIofColorStack(
  file: StackOcadFile,
  opts: ApplyIofColorStackOpts = {},
): ColorStackResult {
  const profile = opts.profile ?? "auto";
  const usage = collectUsage(file.symbols ?? []);
  const colors = definedColors(file);
  const warnings: string[] = [];

  // Auto + named "Lower purple" colour → use the file's own order as the
  // boundary (everything currently above that colour stays above).
  if (profile === "auto") {
    const lower = findLowerPurpleColour(colors);
    if (lower) {
      const above: StackColor[] = [];
      const below: StackColor[] = [];
      for (const color of colors) {
        if (color.renderOrder < lower.renderOrder) above.push(color);
        else below.push(color);
      }
      const overridden = applyOverrides(above, below, opts.overrides);
      const boundary = rewriteOrders(overridden.above, overridden.below);
      // Still report a scale-based profile for UI context.
      const { resolvedProfile } = resolveColorProfile("auto", opts.scale);
      return {
        boundary,
        above: overridden.above.map((c) => c.number),
        below: overridden.below.map((c) => c.number),
        warnings,
        resolvedProfile,
        resolvedBy: "file-colour",
      };
    }
  }

  const { resolvedProfile, resolvedBy } = resolveColorProfile(profile, opts.scale);

  let above: StackColor[] = [];
  let below: StackColor[] = [];
  for (const color of colors) {
    if (isAboveLowerPurple(color, usage.get(color.number), resolvedProfile)) {
      above.push(color);
    } else {
      below.push(color);
    }
  }

  ({ above, below } = applyOverrides(above, below, opts.overrides));

  if (above.length === 0) {
    warnings.push("no black/brown/blue 100% line/point colour found for ink layer");
  } else {
    const hasBlack = above.some((color) => {
      const [c, m, y, k] = cmyk(color);
      return isBlack100(c, m, y, k);
    });
    if (!hasBlack) {
      warnings.push("no black 100% line/point colour found above lower purple");
    }
  }

  const boundary = rewriteOrders(above, below);

  return {
    boundary,
    above: above.map((color) => color.number),
    below: below.map((color) => color.number),
    warnings,
    resolvedProfile,
    resolvedBy,
  };
}

/** Ink-layer `toColor` for `ocadToSvg`, or `null` when the ink layer is empty. */
export function inkToColor(result: ColorStackResult): number | null {
  return result.boundary > 0 ? result.boundary - 1 : null;
}

/**
 * Drop magnetic-north line objects (ISOM 601.x) from an object list so
 * they stay below the course purple in the ink layer. The composite
 * render keeps them.
 */
export function filterNorthLineObjects<T extends StackOcadObject>(
  objects: T[] | undefined | null,
): T[] | undefined {
  if (!objects) return undefined;
  return objects.filter((o) => {
    const sym = o.sym;
    if (sym == null || !Number.isFinite(sym)) return true;
    return Math.floor(sym / 1000) !== MERIDIAN_SYMBOL_BASE;
  });
}

export function isMeridianSymbol(sym: number | undefined | null): boolean {
  if (sym == null || !Number.isFinite(sym)) return false;
  return Math.floor(sym / 1000) === MERIDIAN_SYMBOL_BASE;
}
