/**
 * Colour roles (docs/map-symbols.md §9.3 "Roles"; slice I row I2).
 *
 * The unit that takes a place in the IOF colour order is a colour *use*:
 * one colour reference of one symbol's source `render`. One source colour
 * often serves several IOF rows (brown 50 % as paved area and as road
 * infill; one black as buildings and cultivated-land dots), so the role is
 * decided per use, from the symbol's matched library entry first, else
 * from a rule on the colour's class and percent, the symbol's kind and the
 * part that draws. Pure; nothing in the importer calls it yet (row I3).
 */

import type { SymbolMatch } from "../map-document/header.js";
import type { RenderSymbol } from "../render/symbol.js";
import { type ColourPath, renderColourPaths } from "../render/transform.js";
import { getLibraryEntry } from "../symbol-library/index.js";
import { type PaletteEdition, paletteFor, type SpecId } from "../symbol-library/palette.js";
import { colourRefs } from "../symbol-library/schema.js";
import { alignmentPalette, type SourceColourInfo } from "./colour-align.js";
import { classifyCmyk, type ColourClass, sameClass } from "./colour-class.js";

/**
 * The part of a symbol a colour reference draws (docs/map-symbols.md §9.3
 * table "Parts"). Line bodies inside an area (`border`) are the area's
 * `area-border`, whatever draws in them.
 */
export type ColourPart =
  | "area-fill"
  | "area-hatch"
  | "area-pattern"
  | "area-border"
  | "line-main"
  | "line-halo"
  | "line-outline"
  | "line-infill"
  | "line-glyph"
  | "point-glyph"
  | "text"
  | "text-halo"
  | "text-shadow"
  | "text-frame";

/** One colour reference of a symbol's render: the colour index, where it sits, and what it draws. */
export interface ColourUse {
  colour: number;
  path: ColourPath;
  part: ColourPart;
}

/** The part a reference at `path` draws in a symbol of `type`. */
export function colourPartOf(type: RenderSymbol["type"], path: ColourPath): ColourPart {
  const [head] = path;
  switch (type) {
    case "area":
      if (head === "fill") return "area-fill";
      if (head === "hatches") return "area-hatch";
      if (head === "patterns") return "area-pattern";
      return "area-border";
    case "line":
      if (head === "main") return path[1] === "halo" ? "line-halo" : "line-main";
      if (head === "borders") return path[1] === "backgroundColour" ? "line-infill" : "line-outline";
      return "line-glyph";
    case "point":
      return "point-glyph";
    case "text":
      if (head === "halo") return "text-halo";
      if (head === "shadow") return "text-shadow";
      if (head === "frame") return "text-frame";
      return "text";
  }
}

/** Every colour reference of `render` as a use, in the IR's order; a colour referenced twice is two uses. */
export function colourUses(render: RenderSymbol): ColourUse[] {
  return renderColourPaths(render).map(({ path, colour }) => ({ colour, path, part: colourPartOf(render.type, path) }));
}

// ---- Roles -------------------------------------------------------------------

/**
 * What roles are chosen from, built once per document: the spec's own rows
 * (what a rule may return) and the class of every alignment-palette row
 * (what a hint may return: overlay rows included, `orange-skio` in iof2022
 * as its 2024 row).
 */
export interface RolePalette {
  spec: SpecId;
  edition: PaletteEdition;
  /** `paletteFor(edition, spec)` ids. */
  own: ReadonlySet<string>;
  /** `alignmentPalette(edition, spec)`: id → class of the row's CMYK. */
  classes: ReadonlyMap<string, ColourClass | null>;
}

export function rolePalette(spec: SpecId, edition: PaletteEdition): RolePalette {
  return {
    spec,
    edition,
    own: new Set(paletteFor(edition, spec).map((p) => p.id)),
    classes: new Map(alignmentPalette(edition, spec).map((p) => [p.id, classifyCmyk(p.cmyk)])),
  };
}

/** The parts of a document symbol roles read: its render and its match (any state). */
export interface RoleSymbol {
  render: RenderSymbol;
  match?: Pick<SymbolMatch, "canonicalId"> | null;
}

/** What roles read of a source colour (`identifySourceColours`), indexed by colour index. */
export type RoleColourInfo = Pick<SourceColourInfo, "class" | "paletteId">;

const entryIdsCache = new Map<string, readonly string[] | null>();
function entryPaletteIds(canonicalId: string): readonly string[] | null {
  let ids = entryIdsCache.get(canonicalId);
  if (ids === undefined) {
    const entry = getLibraryEntry(canonicalId);
    ids = entry ? [...colourRefs(entry.render)] : null;
    entryIdsCache.set(canonicalId, ids);
  }
  return ids;
}

/**
 * The hint (docs/map-symbols.md §9.3): the library entry of
 * `match.canonicalId` — in any match state, applied or only suggested —
 * when it uses exactly one alignment-palette id of the source colour's
 * class (`sameClass`). `null` otherwise.
 */
export function roleFromMatch(use: ColourUse, infos: readonly RoleColourInfo[], symbol: RoleSymbol, palette: RolePalette): string | null {
  const cls = infos[use.colour]?.class;
  const canonicalId = symbol.match?.canonicalId;
  if (!cls || !canonicalId) return null;
  const ids = entryPaletteIds(canonicalId);
  if (!ids) return null;
  const same = ids.filter((id) => palette.classes.has(id) && sameClass(palette.classes.get(id), cls));
  return same.length === 1 ? same[0] : null;
}

/** Per-spec choices of the rule table (docs/map-symbols.md §9.3 "Rules"). */
interface SpecRules {
  brownFull: { point: string; other: string };
  brownRoad: readonly string[];
  brownPaved: readonly string[];
  blueFull: { area: string; point: string; other: string };
  blueScreens: readonly string[];
  darkGreen: { area: string | null; other: string };
  yellow: readonly string[];
}

export const ROLE_RULES: Readonly<Partial<Record<SpecId, SpecRules>>> = {
  "ISOM2017-2": {
    brownFull: { point: "brown100-point", other: "brown100-line" },
    brownRoad: ["brown50-road"],
    brownPaved: ["brown50-paved"],
    blueFull: { area: "blue100-area", point: "blue100-point", other: "blue100-line" },
    blueScreens: ["blue70-area", "blue50-area"],
    // ISOM's only dark green is the hedge line colour (§9.1).
    darkGreen: { area: null, other: "darkgreen-hedge" },
    yellow: ["yellow100", "yellow75", "yellow50"],
  },
  "ISSprOM2019-2": {
    brownFull: { point: "brown100", other: "brown100" },
    brownRoad: ["brown50-road", "brown30-road"],
    brownPaved: ["brown50-paved", "brown30-paved"],
    blueFull: { area: "blue100-area", point: "blue100-pointline", other: "blue100-pointline" },
    blueScreens: ["blue70-area", "blue50-area", "blue30-area"],
    darkGreen: { area: "darkgreen-area", other: "darkgreen-line" },
    yellow: ["yellow100", "yellow50"],
  },
};

const BLACK_SCREENS = ["black50-building", "black-area-screen", "black20-canopy"] as const;
const AREA_PARTS: ReadonlySet<ColourPart> = new Set(["area-fill", "area-hatch", "area-pattern"]);
/** The ISSkiOM rows a colour keeps for every use once §9.1 identified it (answer Q2); `white-skio` is hint-only like every white. */
const SKI_ROLE_IDS: ReadonlySet<string> = new Set(["green-skio", "orange-skio"]);

/** The rule's candidate of `ids` for `cls`: the spec's own rows of the same class, nearest percent, ties to the earlier. */
function nearest(cls: ColourClass, ids: readonly string[], palette: RolePalette): string | null {
  let best: string | null = null;
  let bestOff = Infinity;
  for (const id of ids) {
    const c = palette.classes.get(id);
    if (!c || !palette.own.has(id) || !sameClass(c, cls)) continue;
    const off = Math.abs(c.percent - cls.percent);
    if (off < bestOff) {
      best = id;
      bestOff = off;
    }
  }
  return best;
}

const isBrownScreen = (c: ColourClass | null | undefined): boolean => !!c && c.hue === "brown" && c.percent < 100;

/** Black 100 %: road outline round a brown screen, cultivated-land dots on a yellow area, else black 100 %. */
function blackFullRole(use: ColourUse, infos: readonly RoleColourInfo[], render: RenderSymbol): string {
  const classOf = (i: number | undefined) => (i === undefined ? null : infos[i]?.class);
  if (render.type === "line") {
    if (use.part === "line-outline" && isBrownScreen(classOf(render.borders?.backgroundColour))) return "black-road-outline";
    if (use.part === "line-halo" && isBrownScreen(classOf(render.main?.colour))) return "black-road-outline";
  }
  if (render.type === "area") {
    if (use.part === "area-border" && isBrownScreen(classOf(render.fill))) return "black-road-outline";
    if (use.part === "area-pattern" && classOf(render.fill)?.hue === "yellow") {
      const pattern = render.patterns?.[use.path[1] as number];
      if (pattern && pattern.glyph.parts.every((p) => p.kind === "disc")) return "black-cultivated";
    }
  }
  return "black100";
}

/**
 * Steps 2 and 3 of docs/map-symbols.md §9.3 "Roles": a colour §9.1
 * identified as an ISSkiOM track colour keeps that row (on any spec);
 * otherwise the rule table, a role from the colour's class and percent,
 * the symbol's kind and the part that draws. Whites, purples, orange, red,
 * registration and unclassified colours get none from the table; a spec
 * without a table gives none beyond the ski step.
 */
export function roleFromRule(use: ColourUse, infos: readonly RoleColourInfo[], symbol: RoleSymbol, palette: RolePalette): string | null {
  const info = infos[use.colour];
  const cls = info?.class;
  if (!cls) return null;
  if (info.paletteId && SKI_ROLE_IDS.has(info.paletteId) && palette.classes.has(info.paletteId)) return info.paletteId;
  const rules = ROLE_RULES[palette.spec];
  if (!rules) return null;
  const area = AREA_PARTS.has(use.part);
  const full = cls.percent === 100;
  const pick = (id: string | null) => (id && palette.own.has(id) ? id : null);
  switch (cls.hue) {
    case "black":
      return full ? pick(blackFullRole(use, infos, symbol.render)) : nearest(cls, BLACK_SCREENS, palette);
    case "brown":
      if (full) return pick(use.part === "point-glyph" ? rules.brownFull.point : rules.brownFull.other);
      return nearest(cls, use.part.startsWith("line-") ? rules.brownRoad : rules.brownPaved, palette);
    case "blue":
      if (full) return pick(area ? rules.blueFull.area : use.part === "point-glyph" ? rules.blueFull.point : rules.blueFull.other);
      return nearest(cls, rules.blueScreens, palette);
    case "green":
      return nearest(cls, area ? ["green100-area", "green60-area", "green30-area"] : ["green100-point", "green60-area", "green30-area"], palette);
    case "darkgreen":
      return pick(area ? rules.darkGreen.area : rules.darkGreen.other);
    case "yellow":
      return nearest(cls, rules.yellow, palette);
    case "olive":
      return pick("olive");
    default:
      return null;
  }
}

/** A use's role (docs/map-symbols.md §9.3): the hint, else the rule, else none. Whites and purples have no rule. */
export function roleOfUse(use: ColourUse, infos: readonly RoleColourInfo[], symbol: RoleSymbol, palette: RolePalette): string | null {
  return roleFromMatch(use, infos, symbol, palette) ?? roleFromRule(use, infos, symbol, palette);
}

export interface ColourRole extends ColourUse {
  /** Palette id, or `null`: no role (I4's source order). */
  role: string | null;
  via: "match" | "rule" | null;
}

/** Every use of a symbol's render with its role and what decided it. */
export function colourRoles(symbol: RoleSymbol, infos: readonly RoleColourInfo[], palette: RolePalette): ColourRole[] {
  return colourUses(symbol.render).map((use) => {
    const hint = roleFromMatch(use, infos, symbol, palette);
    if (hint) return { ...use, role: hint, via: "match" };
    const rule = roleFromRule(use, infos, symbol, palette);
    return { ...use, role: rule, via: rule ? "rule" : null };
  });
}
