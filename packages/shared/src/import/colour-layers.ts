/**
 * The layered colour stack (docs/map-symbols.md §9.3 "Layers"; slice I
 * rows I3 and I4): the document's colours as one row per (source colour,
 * role), in the IOF palette's order instead of the mapper's table. A source
 * colour that serves several roles (brown 50 % as paved area and road
 * infill) becomes several rows with the same ink, and each symbol's
 * `render` is re-indexed per reference, so every part draws on its own
 * layer. `header.colours` stays "index = draw order": the renderers, the
 * course layer and materialisation read it as before.
 *
 * Row I4 adds what the palette cannot place, by the source order (§9.3
 * "Source order": uses with no role, graphic objects' colours, mask whites),
 * the deviations (§9.3 "Deviations": pairs of roles the source orders
 * against the palette, kept or dropped) and a symbol's own parts kept in
 * their source order (§9.3 "Own order").
 *
 * Row I5 wires it into import stage 7 (`match-document.ts`, `colourOrder:
 * "iof"`, the default). Pure.
 */

import type { DocumentColour, DocumentSymbol, SymbolMatch } from "../map-document/header.js";
import type { RenderSymbol } from "../render/symbol.js";
import { getLibraryEntry } from "../symbol-library/index.js";
import { type PaletteEdition, palettes, type SpecId } from "../symbol-library/palette.js";
import { colourRefs } from "../symbol-library/schema.js";
import { alignmentPalette, OVERLAY_STACK_IDS, type SourceColourInfo } from "./colour-align.js";
import { nameKind, paletteClass, sameClass, SKI_PALETTE_IDS } from "./colour-class.js";
import { colourRoles, type RoleColourInfo, type RolePalette } from "./colour-roles.js";

/** The kind of symbol a row of uses with no role is drawn by (part of its key and id; the place is the source order's). */
export type NoRolePlace = "area" | "other";

/** The uses of one document symbol, as `buildColourLayers` reads them. */
export interface LayerSymbolUses {
  /** Objects drawn with the symbol (hidden symbols included, as stage 7's `usage`). */
  objects: number;
  /** `render.type`. */
  type: RenderSymbol["type"];
  /** The symbol's origin; graphic objects' colours are placed by the source order. */
  origin: NonNullable<DocumentSymbol["origin"]>;
  /**
   * The symbol is drawn from its library entry (an applied match, `isAppliedMatch`), not from this render: its
   * parts' order is the library's, so §9.3 "Own order" leaves it alone. Absent: drawn from source.
   */
  library?: boolean;
  /**
   * For a library-drawn symbol: the palette ids its entry draws with (`colourRefs(entry.render)`, as stage 7's
   * `needed`). Its objects count on the rows carrying them, not on its own references' rows (§9.3 "Deviations",
   * row I5). Absent: the roles of `uses`.
   */
  libraryIds?: readonly string[];
  /** Every colour reference of the render in `renderColourPaths` order, with its role (`colourRoles`). */
  uses: readonly { colour: number; role: string | null }[];
}

/** A document symbol as `symbolColourUses` reads it. */
export interface LayerSymbol {
  render?: RenderSymbol | null;
  match?: (Pick<SymbolMatch, "canonicalId"> & Partial<Pick<SymbolMatch, "state" | "reviewed">>) | null;
  origin?: DocumentSymbol["origin"];
}

/** `isAppliedMatch` (map-document/render-bridge.ts): drawn canonically when automatic or confirmed by review. */
const applied = (m: LayerSymbol["match"]): boolean => !!m && m.canonicalId !== null && (m.state === "auto" || m.reviewed === true);

/**
 * The uses of every document symbol (`null` for a symbol without a render):
 * `colourRoles` per symbol, with its object count, kind, origin and whether
 * it is drawn from its library entry. Throws on a reference outside the
 * colour table.
 */
export function symbolColourUses(
  symbols: readonly LayerSymbol[],
  objectsPerSymbol: ArrayLike<number>,
  infos: readonly RoleColourInfo[],
  palette: RolePalette,
): (LayerSymbolUses | null)[] {
  return symbols.map((s, i) => {
    if (!s.render) return null;
    const uses = colourRoles({ render: s.render, match: s.match ?? null }, infos, palette).map(({ colour, role }) => {
      if (!Number.isInteger(colour) || colour < 0 || colour >= infos.length) throw new Error(`symbol ${i} references colour index ${colour} outside the ${infos.length}-entry colour table`);
      return { colour, role };
    });
    const out: LayerSymbolUses = { objects: objectsPerSymbol[i] ?? 0, type: s.render.type, origin: s.origin ?? "source", uses };
    if (applied(s.match)) {
      out.library = true;
      const entry = getLibraryEntry(s.match!.canonicalId!);
      if (entry) out.libraryIds = [...new Set(colourRefs(entry.render))].sort();
    }
    return out;
  });
}

/**
 * The layered stack cannot be built for this map (an order whose constraints cannot be resolved). Stage 7 falls back
 * to the source order with `COLOUR_LAYERS_FAILED` (row I5); a bad input (a reference outside the table) is a plain
 * `Error`, not this.
 */
export class ColourLayersError extends Error {
  constructor(message: string) {
    super(`buildColourLayers: ${message}`);
    this.name = "ColourLayersError";
  }
}

/** What a deviation is set to (`ColourLayersInput.deviations`). */
export type DeviationChoice = "keep" | "drop";

/** The key of a deviation: the role the source draws on top, then the one under it (`"brown50-road>brown100-line"`). */
export const deviationKey = (upper: string, lower: string): string => `${upper}>${lower}`;

/**
 * Deviations kept unless the input says otherwise (the user's answer 2,
 * 2026-11-17: roads over contours): road infill, paved-area brown and the
 * road outline drawn over the contour brown. Every other deviation is
 * dropped by default.
 */
export const KEPT_BY_DEFAULT: ReadonlySet<string> = new Set(
  ["brown50-road", "brown30-road", "brown50-paved", "brown30-paved", "black-road-outline"].flatMap((u) => ["brown100-line", "brown100"].map((l) => deviationKey(u, l))),
);

export interface ColourLayersInput {
  /** The source colour table, in source order (as the reader gives it, before §9.2's alignment). */
  colours: readonly DocumentColour[];
  /** `identifySourceColours(colours, spec, edition)`. */
  infos: readonly SourceColourInfo[];
  /** Per document symbol: `symbolColourUses`; `null` for a symbol without a render. */
  uses: readonly (LayerSymbolUses | null)[];
  /** Palette ids applied matches draw with (stage 7's `needed`). */
  needed: ReadonlySet<string>;
  spec: SpecId;
  edition: PaletteEdition;
  /** Per deviation key (`deviationKey`), keep or drop, overriding `KEPT_BY_DEFAULT`. */
  deviations?: Readonly<Record<string, DeviationChoice>>;
}

/** How a row came to be. */
export type LayerOrigin =
  /** A (source colour, role) some symbol references. */
  | "use"
  /** A palette id a match needs and no row has, drawn in a same-class source colour's ink (§9.2 step 3's alias). */
  | "alias"
  /** A palette id no source colour gives: the palette's ink, or for the course purples the map's purple (§9.2 step 4). */
  | "insert"
  /** A source colour no symbol references, kept once. */
  | "unreferenced"
  /**
   * A palette id §9.1 identified a source colour as, carried on a zero-object row of that colour at the id's palette
   * place because none of the colour's rows can carry it (row I5): §9.2 carries every identified id, so must the
   * layers. Nothing references it; it is never the colour's lowest row.
   */
  | "identified";

/** Why a row stands where the source order puts it rather than at a palette place (§9.3 "Source order"). */
export type SourceOrderReason =
  /** Uses with no role. */
  | "no-role"
  /** The colour's uses by graphic objects' symbols (`origin: "graphic"`: logos, frame bars). */
  | "graphic"
  /** A white the source draws over a layer the palette ranks above its role: a mask. */
  | "mask";

export interface ColourLayerRow {
  /** Index in the layered stack (= draw order). */
  row: number;
  /** Source colour index; `null` for an inserted row. */
  source: number | null;
  /** Palette id of the alignment palette; `null`: no role (and a graphic row). */
  role: string | null;
  /** For a row of uses with no role: the kind of symbol drawing them (`area` or `other`); part of its id. */
  place: NoRolePlace | null;
  origin: LayerOrigin;
  /** Objects drawn in the row: source-drawn symbols referencing it (once each), and on a row carrying a palette id the library-drawn symbols whose entry draws with it (row I5). */
  objects: number;
  /** Symbols referencing the row. */
  symbols: number;
  /** Objects of `origin: "graphic"` symbols among `objects`. */
  graphicObjects: number;
  /** Placed by the source order, and why; `null`: at its role's palette place. */
  sourceOrdered: SourceOrderReason | null;
  /** A row of parts moved under a part of their own symbol that the source draws over them (§9.3 "Own order"). */
  ownOrder: boolean;
}

/** A deviation (§9.3 "Deviations"): the source draws `upper` over `lower`, the palette ranks `lower` above. */
export interface ColourDeviation {
  upper: string;
  lower: string;
  /** Drawn in the source's order (kept) or the palette's (dropped). */
  kept: boolean;
  /** No override decided it: `KEPT_BY_DEFAULT`, or kept because another kept deviation needs it (`impliedBy`). */
  byDefault: boolean;
  /** Objects drawn in the rows of each side that the source orders against the palette (source-drawn objects, and library-drawn ones on the row carrying their palette id). */
  objects: { upper: number; lower: number };
  /** Kept because the kept deviations listed cannot hold without it (dropped by default otherwise). */
  impliedBy?: string[];
  /** Wanted kept, but it cannot hold with the order of the roles listed (source and palette agree on them, or they were kept first): drawn dropped. */
  blockedBy?: string[];
}

export interface ColourLayersReport {
  /** Every row, bottom first. */
  rows: ColourLayerRow[];
  /** Source colours on several rows, with their rows' roles bottom first (`null`: no role). */
  split: { source: number; sourceNumber?: number; roles: (string | null)[] }[];
  /** Rows placed by the source order, bottom first; `aboveLowerPurple` where the source order puts them over the course's lower purple. */
  sourceOrdered: { row: number; source: number; sourceNumber?: number; reason: SourceOrderReason; role: string | null; objects: number; aboveLowerPurple: boolean }[];
  /** Rows of uses with no role, bottom first. */
  noRole: { row: number; source: number; sourceNumber?: number; place: NoRolePlace; objects: number }[];
  /** Every deviation, the most objects first (ties by key). */
  deviations: ColourDeviation[];
  /** Palette ids inserted, bottom first. */
  inserted: string[];
  /** Palette ids drawn in a source colour's ink because a match needs them (the shape of `ColourStackSummary.aliased`). */
  aliased: { paletteId: string; viaPaletteId: string; sourceNumber?: number }[];
  /** The source colour whose ink the course purples take; `null`: the palette's. */
  purpleInk: number | null;
}

export interface ColourLayersResult {
  colours: DocumentColour[];
  reindex: {
    /** Per document symbol: the row of each colour reference in `renderColourPaths` order (`reindexRenderColours`); `null` without a render. */
    symbols: (number[] | null)[];
    /** Per source colour: its lowest row (one row per colour: proxies, a caller that maps colours rather than references). */
    colours: number[];
  };
  report: ColourLayersReport;
}

const COURSE_PURPLES = ["purple-lower", "purple-upper"] as const;
const isCoursePurple = (id: string | null | undefined): boolean => id === "purple-lower" || id === "purple-upper";

/** The edition an inserted row's id carries: its own, or 2024 for a row the edition lacks (as §9.2). */
const rowEdition = (edition: PaletteEdition, id: string): PaletteEdition => (palettes[edition].some((p) => p.id === id) ? edition : "iof2024");

/** A sort key: palette rank, then the depth under it (§9.3 "Own order": 0 at the role's place, −1 under every row of it, …). */
type Key = readonly [rank: number, sub: number];
const cmpKey = (a: Key, b: Key): number => a[0] - b[0] || a[1] - b[1];
const below = (k: Key): Key => [k[0], k[1] - 1];

interface Draft {
  key: string;
  source: number | null;
  role: string | null;
  place: NoRolePlace | null;
  origin: LayerOrigin;
  objects: number;
  graphicObjects: number;
  symbols: Set<number>;
  /** Its place among the palette-placed rows; `null` for a source-ordered row. */
  base: Key | null;
  sourceOrdered: SourceOrderReason | null;
  ownOrder: boolean;
  /** The row's id suffix after the colour's id (`brown50-road`, `none:area`, `graphic`, `brown50-road/under1`). */
  suffix: string;
  /** A row made only to carry an identified palette id (row I5): nothing references it, and the source-order gap does not count it. */
  idOnly?: boolean;
}

/**
 * Builds the layered stack (docs/map-symbols.md §9.3 "Layers", "Own order",
 * "Deviations", "Source order"):
 *
 * - one row per (source colour, role) that a symbol references, zero-object
 *   symbols included; a use with no role is keyed by its symbol's kind, a
 *   graphic object's use by its colour alone;
 * - a symbol's parts keep their source order: a part whose role ranks above
 *   a part the source draws over it goes to a row of its own just under
 *   that part's role;
 * - rows ordered by their role's place in `alignmentPalette(edition, spec)`,
 *   rows of one place in source order, then each deviation the source draws
 *   against the palette kept (source order) or dropped (palette order):
 *   `KEPT_BY_DEFAULT` unless `deviations` says otherwise; kept deviations
 *   that cannot hold together are resolved and reported;
 * - uses with no role, graphic objects' colours and mask whites in the gap
 *   of the placed rows the source order fits best;
 * - each palette id on exactly one row at its palette place (`paletteIds`):
 *   the row of the colour §9.2 gives it (identified, else for a needed id
 *   aliased to the most used identified colour of its class; a row of its
 *   own if that colour has none), else its row with the most objects, ties
 *   to the lowest source index, else for a needed id inserted with the
 *   palette's CMYK; purples and ISSkiOM's rows never alias;
 * - lower and upper purple always inserted at their palette places, in the
 *   ink of the map's most used course-purple candidate (ties to the highest
 *   index), else the palette's; the overlay's rows (`OVERLAY_STACK_IDS`)
 *   always present, `white-skio` directly under lower purple and
 *   `orange-skio` directly under `green-skio` when nothing of the map is
 *   drawn in them;
 * - a source colour no symbol references kept once, at the place of the
 *   palette id §9.1 identified it as (course purples excepted), else by the
 *   source order;
 * - ids: a source colour's lowest row keeps its id, its other rows are
 *   `<id>/<suffix>` (`<paletteId>`, `none:<place>`, `graphic`; a moved
 *   part's `<suffix>/under<n>`; a second row of an id `<paletteId>/alias`);
 *   inserted rows `<edition>:<paletteId>`. Split rows keep the colour's
 *   name, CMYK, `sourceNumber`, spot and overprint.
 */
export function buildColourLayers(input: ColourLayersInput): ColourLayersResult {
  const { colours, infos, edition, spec } = input;
  if (infos.length !== colours.length) throw new Error(`buildColourLayers: ${infos.length} infos for ${colours.length} colours`);
  const palette = alignmentPalette(edition, spec);
  const paletteById = new Map(palette.map((p) => [p.id, p]));
  // Palette rank: 0 = bottom of the stack (drawn first).
  const rank = new Map<string, number>();
  palette.slice().reverse().forEach((p, i) => rank.set(p.id, i));
  for (const id of [...COURSE_PURPLES, "white-skio"]) if (!rank.has(id)) throw new Error(`buildColourLayers: the ${spec} alignment palette has no ${id}`);
  const placeKey = (role: string): Key => [rank.get(role)!, 0];

  // ---- rows of uses, with each symbol's parts in their source order -------------------------------------------------
  const drafts = new Map<string, Draft>();
  const draft = (key: string, init: Omit<Draft, "key" | "objects" | "graphicObjects" | "symbols" | "ownOrder"> & { ownOrder?: boolean }): Draft => {
    let d = drafts.get(key);
    if (!d) {
      d = { key, objects: 0, graphicObjects: 0, symbols: new Set(), ownOrder: false, ...init };
      drafts.set(key, d);
    }
    return d;
  };
  const usage = new Array<number>(colours.length).fill(0);
  /** Per symbol, the draft key of each reference. */
  const useKeys: (string[] | null)[] = [];
  input.uses.forEach((s, symbolIdx) => {
    if (!s) {
      useKeys.push(null);
      return;
    }
    const uses = s.uses.map((u) => {
      if (!Number.isInteger(u.colour) || u.colour < 0 || u.colour >= colours.length) throw new Error(`buildColourLayers: symbol ${symbolIdx} references colour index ${u.colour} outside the ${colours.length}-entry colour table`);
      return { colour: u.colour, role: u.role !== null && rank.has(u.role) ? u.role : null };
    });
    // Own order, pass 1 (§9.3 "Own order"): top-down over the symbol's source colours, a role part whose place is not
    // under every role part the source draws over it goes just under the lowest of them. Library-drawn symbols and
    // graphic objects (placed by the source order as a whole) are left alone; parts with no role wait for pass 2.
    const at: (Key | null)[] = uses.map((u) => (u.role && s.origin !== "graphic" ? placeKey(u.role) : null));
    if (!s.library && s.origin !== "graphic") {
      let ceiling: Key | null = null;
      for (const c of [...new Set(uses.map((u) => u.colour))].sort((a, b) => b - a)) {
        let lowest: Key | null = null;
        uses.forEach((u, k) => {
          if (u.colour !== c || !at[k]) return;
          if (ceiling && cmpKey(at[k]!, ceiling) >= 0) at[k] = below(ceiling);
          if (!lowest || cmpKey(at[k]!, lowest) < 0) lowest = at[k];
        });
        if (lowest && (!ceiling || cmpKey(lowest, ceiling) < 0)) ceiling = lowest;
      }
    }
    const keys: string[] = [];
    const counted = new Set<number>();
    uses.forEach((u, k) => {
      let d: Draft;
      if (s.origin === "graphic") d = draft(`${u.colour}|graphic`, { source: u.colour, role: null, place: null, origin: "use", base: null, sourceOrdered: "graphic", suffix: "graphic" });
      else if (!u.role) {
        const place: NoRolePlace = s.type === "area" ? "area" : "other";
        d = draft(`${u.colour}|none:${place}`, { source: u.colour, role: null, place, origin: "use", base: null, sourceOrdered: "no-role", suffix: `none:${place}` });
      } else {
        const key = at[k]!;
        const moved = key[1] !== 0 || key[0] !== rank.get(u.role);
        d = draft(`${u.colour}|${u.role}${moved ? `|${key[0]}:${key[1]}` : ""}`, { source: u.colour, role: u.role, place: null, origin: "use", base: key, sourceOrdered: null, ownOrder: moved, suffix: u.role });
      }
      if (!d.symbols.has(symbolIdx)) {
        d.symbols.add(symbolIdx);
        d.objects += s.objects;
        if (s.origin === "graphic") d.graphicObjects += s.objects;
      }
      if (!counted.has(u.colour)) {
        counted.add(u.colour);
        usage[u.colour] += s.objects;
      }
      keys.push(d.key);
    });
    useKeys.push(keys);
  });

  // Source colours no symbol references: kept once, at their identified place, else by the source order.
  const hasRow = new Set([...drafts.values()].map((d) => d.source));
  colours.forEach((c, i) => {
    if (hasRow.has(i)) return;
    const id = infos[i]?.paletteId;
    const role = id && !isCoursePurple(id) && rank.has(id) ? id : null;
    if (role) draft(`${i}|${role}`, { source: i, role, place: null, origin: "unreferenced", base: placeKey(role), sourceOrdered: null, suffix: role });
    else {
      const place: NoRolePlace = nameKind(c.name) === "area" ? "area" : "other";
      draft(`${i}|none:${place}`, { source: i, role: null, place, origin: "unreferenced", base: null, sourceOrdered: "no-role", suffix: `none:${place}` });
    }
  });

  // ---- mask whites (§9.3 "Source order") ----------------------------------------------------------------------------
  // A white role row drawn by source symbols that the source draws over a used row the palette ranks above it.
  const drawnBySource = new Map<Draft, number>();
  input.uses.forEach((s, i) => {
    if (!s || s.library) return;
    for (const k of new Set(useKeys[i])) {
      const d = drafts.get(k)!;
      drawnBySource.set(d, (drawnBySource.get(d) ?? 0) + s.objects);
    }
  });
  const roleRows = () => [...drafts.values()].filter((d) => d.base && d.source !== null);
  for (const w of roleRows()) {
    if (infos[w.source!]?.class?.hue !== "white" || w.role === "white-skio" || !(drawnBySource.get(w) ?? 0)) continue;
    const covers = roleRows().some((x) => x !== w && x.objects > 0 && x.source! < w.source! && infos[x.source!]?.class?.hue !== "white" && cmpKey(x.base!, w.base!) > 0);
    if (covers) {
      w.base = null;
      w.sourceOrdered = "mask";
    }
  }

  // ---- palette ids: carriers, aliases, inserts ------------------------------------------------------------------------
  // Which row carries each palette id (library symbols draw there): the row, at the id's palette place, of the colour
  // §9.2 gives the id — step 2, the colour identified as it (the most used, ties to the lowest index); for a needed id
  // with none, step 3's alias, the most used identified colour of its class — so a library symbol keeps the ink it has
  // on the source order. A needed id whose colour has no such row gets one (an `alias` row); an id with no such colour
  // is carried by its row with the most objects (ties to the lowest index), a needed one with no row at all inserted.
  const better = (a: number, b: number) => usage[a] > usage[b] || (usage[a] === usage[b] && a < b);
  const identifiedAs = new Map<string, number>();
  for (const info of infos) {
    if (!info.paletteId || isCoursePurple(info.paletteId)) continue;
    const cur = identifiedAs.get(info.paletteId);
    if (cur === undefined || better(info.index, cur)) identifiedAs.set(info.paletteId, info.index);
  }
  const aliasColour = (id: string): number | undefined => {
    const cls = paletteClass(id, rowEdition(edition, id));
    if (!cls || cls.hue === "purple" || SKI_PALETTE_IDS.has(id)) return undefined;
    let via: number | undefined;
    for (const info of infos) {
      if (!info.paletteId || SKI_PALETTE_IDS.has(info.paletteId) || !sameClass(info.class, cls)) continue;
      if (via === undefined || better(info.index, via)) via = info.index;
    }
    return via;
  };
  // Every id §9.2 step 2 identifies is carried too (row I5), as on the source order: Map mode and a patch re-resolved
  // onto this stack find the same palette ids (§11, map-patches §4.2), on a zero-object row of the colour if need be.
  const required = new Set<string>([...input.needed, ...COURSE_PURPLES, ...OVERLAY_STACK_IDS]);
  const wanted = new Set<string>([...required, ...identifiedAs.keys()]);
  const placeable = (d: Draft | undefined) => d && d.base && !d.ownOrder;
  const carrier = new Map<string, Draft>();
  const aliased: ColourLayersReport["aliased"] = [];
  const roles = new Set([...drafts.values()].flatMap((d) => (d.role && placeable(d) ? [d.role] : [])));
  const ids = [...new Set([...roles, ...wanted])].filter((id) => rank.has(id) && !isCoursePurple(id)).sort((a, b) => rank.get(a)! - rank.get(b)!);
  for (const id of ids) {
    const step2 = identifiedAs.get(id);
    const colour = step2 ?? (wanted.has(id) ? aliasColour(id) : undefined);
    const own = colour === undefined ? undefined : drafts.get(`${colour}|${id}`);
    if (colour !== undefined && placeable(own)) {
      carrier.set(id, own!);
      continue;
    }
    if (colour !== undefined && wanted.has(id)) {
      // A colour whose own row of this role went elsewhere (a mask, a moved part) gets a second one at the palette place.
      const key = own ? `${colour}|${id}|alias` : `${colour}|${id}`;
      const idOnly = !required.has(id);
      const d = draft(key, { source: colour, role: id, place: null, origin: idOnly ? "identified" : "alias", base: placeKey(id), sourceOrdered: null, suffix: own ? `${id}/alias` : id });
      if (idOnly) d.idOnly = true;
      carrier.set(id, d);
      if (step2 === undefined) aliased.push({ paletteId: id, viaPaletteId: infos[colour].paletteId!, ...(colours[colour].sourceNumber !== undefined ? { sourceNumber: colours[colour].sourceNumber } : {}) });
      continue;
    }
    let best: Draft | undefined;
    for (const d of drafts.values()) {
      if (d.role !== id || !placeable(d)) continue;
      if (!best || d.objects > best.objects || (d.objects === best.objects && d.source! < best.source!)) best = d;
    }
    if (best) carrier.set(id, best);
    else if (wanted.has(id)) carrier.set(id, draft(`insert|${id}`, { source: null, role: id, place: null, origin: "insert", base: placeKey(id), sourceOrdered: null, suffix: id }));
  }
  for (const id of COURSE_PURPLES) carrier.set(id, draft(`insert|${id}`, { source: null, role: id, place: null, origin: "insert", base: placeKey(id), sourceOrdered: null, suffix: id }));

  // What each row draws: the objects of source-drawn symbols referencing it, and on the row carrying a palette id the
  // objects of library-drawn symbols whose entry draws with that id (their own references draw nothing; row I5).
  const drawn = new Map(drawnBySource);
  const libraryIdsOf = (s: LayerSymbolUses): Set<string> => new Set(s.libraryIds ?? s.uses.flatMap((u) => (u.role ? [u.role] : [])));
  const libraryByRole = new Map<string, number>();
  for (const s of input.uses) {
    if (!s?.library) continue;
    for (const role of libraryIdsOf(s)) libraryByRole.set(role, (libraryByRole.get(role) ?? 0) + s.objects);
  }
  for (const [role, n] of libraryByRole) {
    const c = carrier.get(role);
    if (c) drawn.set(c, (drawn.get(c) ?? 0) + n);
  }
  const drawnObjects = (d: Draft) => drawn.get(d) ?? 0;

  // ---- the palette-placed rows: base order, deviations, kept ones in source order ----------------------------------
  const placed = [...drafts.values()].filter((d) => d.base);
  const srcOf = (d: Draft) => d.source ?? colours.length; // an inserted row above the source rows of its place
  const baseCmp = (a: Draft, b: Draft) => cmpKey(a.base!, b.base!) || srcOf(a) - srcOf(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  placed.sort(baseCmp);
  const pos = new Map(placed.map((d, i) => [d, i]));
  // Rows whose order relations count: something is drawn in them, from a source colour.
  const used = placed.filter((d) => drawnObjects(d) > 0 && d.source !== null);

  interface DevAcc { upper: string; lower: string; upperRows: Set<Draft>; lowerRows: Set<Draft> }
  const devs = new Map<string, DevAcc>();
  /**
   * The deviation a pair of used rows makes, if any: the source draws one over the other while both the palette (by
   * role; rows of one role go by the source) and the base order put it under. Where the source agrees with the palette
   * (a part pass 1 moved, against another colour's row) or with the base order (pass 1's own move), it is no deviation.
   */
  const contradiction = (a: Draft, b: Draft): string | null => {
    if (a.source === b.source) return null;
    const [hi, lo] = a.source! > b.source! ? [a, b] : [b, a];
    const paletteAgrees = rank.get(hi.role!)! >= rank.get(lo.role!)!;
    return !paletteAgrees && pos.get(hi)! < pos.get(lo)! ? deviationKey(hi.role!, lo.role!) : null;
  };
  for (let i = 0; i < used.length; i++) {
    for (let j = i + 1; j < used.length; j++) {
      const key = contradiction(used[i], used[j]);
      if (!key) continue;
      const [hi, lo] = used[i].source! > used[j].source! ? [used[i], used[j]] : [used[j], used[i]];
      let acc = devs.get(key);
      if (!acc) devs.set(key, (acc = { upper: hi.role!, lower: lo.role!, upperRows: new Set(), lowerRows: new Set() }));
      acc.upperRows.add(hi);
      acc.lowerRows.add(lo);
    }
  }
  const override = input.deviations ?? {};
  const wantKept = (key: string) => (override[key] ?? (KEPT_BY_DEFAULT.has(key) ? "keep" : "drop")) === "keep";
  const keep = new Set<string>([...devs.keys()].filter(wantKept));
  const implied = new Map<string, Set<string>>();
  const blocked = new Map<string, Set<string>>();
  const sumObjects = (rows: Set<Draft>) => [...rows].reduce((t, d) => t + drawnObjects(d), 0);
  const weight = (key: string) => sumObjects(devs.get(key)!.upperRows) + sumObjects(devs.get(key)!.lowerRows);
  const lightest = (keys: string[]) => keys.sort((a, b) => weight(a) - weight(b) || (a < b ? -1 : 1))[0];

  /** Edges "a under b" among the used rows: the base order for a dropped deviation, the source's order otherwise. */
  const buildEdges = () => {
    const out = new Map<Draft, Set<Draft>>(placed.map((d) => [d, new Set()]));
    const why = new Map<string, string | null>();
    for (let i = 0; i < used.length; i++) {
      for (let j = i + 1; j < used.length; j++) {
        const a = used[i], b = used[j];
        if (a.source === b.source) continue;
        const dev = contradiction(a, b);
        const byBase = dev !== null && !keep.has(dev);
        const [lo, hi] = byBase ? (pos.get(a)! < pos.get(b)! ? [a, b] : [b, a]) : a.source! < b.source! ? [a, b] : [b, a];
        out.get(lo)!.add(hi);
        why.set(`${lo.key}\n${hi.key}`, dev);
      }
    }
    return { out, why };
  };
  // Every relation is the source's but a dropped deviation's, so a cycle runs through a dropped one. Break each: keep a
  // deviation in it dropped by default (implied); else drop the kept deviation in it with the fewest objects (blocked)
  // and resolve again from the wanted keeps, so nothing stays implied by a deviation that no longer holds; else keep
  // a deviation an override dropped, as the only order that can be drawn (implied by nothing kept).
  let edges = buildEdges();
  const guardLimit = (devs.size + 2) ** 2;
  for (let guard = 0; ; guard++) {
    const cycle = findCycle(placed, edges.out);
    if (!cycle) break;
    if (guard >= guardLimit) throw new ColourLayersError("deviations that cannot be resolved");
    const inCycle = new Set<string>();
    const roles = new Set<string>();
    cycle.forEach((d, k) => {
      roles.add(d.role!);
      const next = cycle[(k + 1) % cycle.length];
      const dev = edges.why.get(`${d.key}\n${next.key}`);
      if (dev) inCycle.add(dev);
    });
    const keptHere = [...inCycle].filter((k) => keep.has(k));
    const droppedHere = [...inCycle].filter((k) => !keep.has(k));
    const flip = lightest(droppedHere.filter((k) => !override[k] && !blocked.has(k)));
    // A kept deviation in the cycle, or the kept one that an implied deviation in it was implied by.
    const roots = new Set<string>();
    const rootOf = (k: string, seen: Set<string>) => {
      if (seen.has(k)) return;
      seen.add(k);
      if (!implied.has(k)) roots.add(k);
      else for (const by of implied.get(k)!) rootOf(by, seen);
    };
    for (const k of keptHere) rootOf(k, new Set());
    const drop = lightest([...roots].filter((k) => keep.has(k)));
    if (flip) {
      keep.add(flip);
      implied.set(flip, new Set(keptHere));
    } else if (drop) {
      blocked.set(drop, new Set([...roles].filter((r) => r !== devs.get(drop)!.upper && r !== devs.get(drop)!.lower)));
      keep.clear();
      for (const k of devs.keys()) if (wantKept(k) && !blocked.has(k)) keep.add(k);
      implied.clear();
    } else {
      const forced = lightest(droppedHere);
      if (!forced) throw new ColourLayersError("a cycle without a deviation");
      keep.add(forced);
      implied.set(forced, new Set(keptHere));
      blocked.delete(forced);
    }
    edges = buildEdges();
  }
  let order = sortByEdges(placed, edges.out, (d) => d.base!, baseCmp);

  // The ski rows' places (§12.3), where no object of the map is drawn in them.
  const moveUnder = (id: string, anchorId: string, anchorInserted: boolean) => {
    const row = order.find((d) => d.role === id && d.objects === 0 && carrier.get(id) === d);
    const anchor = order.find((d) => d.role === anchorId && carrier.get(anchorId) === d && (!anchorInserted || d.origin === "insert"));
    if (!row || !anchor || row === anchor) return;
    order = order.filter((d) => d !== row);
    order.splice(order.indexOf(anchor), 0, row);
  };
  moveUnder("white-skio", "purple-lower", true);
  moveUnder("orange-skio", "green-skio", false);

  // ---- source-ordered rows: the gap of the placed rows the source order fits best -----------------------------------
  const sourceRows = [...drafts.values()].filter((d) => !d.base).sort((a, b) => a.source! - b.source! || (a.key < b.key ? -1 : 1));
  const top = order.findIndex((d) => d.origin === "insert" && d.role === "purple-upper");
  const closed = new Set<number>();
  const adjacent = (lowerId: string, upperId: string) => {
    const i = order.findIndex((d) => d.role === lowerId && carrier.get(lowerId) === d);
    if (i >= 0 && order[i + 1]?.role === upperId && carrier.get(upperId) === order[i + 1]) closed.add(i + 1);
  };
  adjacent("white-skio", "purple-lower");
  adjacent("orange-skio", "green-skio");
  const gapOf = new Map<Draft, number>();
  for (const r of sourceRows) {
    // cost(g): placed rows under gap g that the source draws over r, plus those over it the source draws under r — by what they draw,
    // then by rows; the lowest gap of the cheapest.
    let best = -1, bestObj = Infinity, bestRows = Infinity;
    let obj = 0, rows = 0;
    for (const d of order) {
      if (d.source !== null && !d.idOnly && d.source !== r.source && d.source < r.source!) {
        obj += drawnObjects(d);
        rows++;
      }
    }
    for (let g = 0; g <= top; g++) {
      if (!closed.has(g) && (obj < bestObj || (obj === bestObj && rows < bestRows))) {
        best = g;
        bestObj = obj;
        bestRows = rows;
      }
      const d = order[g];
      if (!d || d.source === null || d.idOnly || d.source === r.source) continue;
      if (d.source < r.source!) {
        obj -= drawnObjects(d);
        rows--;
      } else {
        obj += drawnObjects(d);
        rows++;
      }
    }
    gapOf.set(r, best);
  }
  const stack: Draft[] = [];
  for (let g = 0; g <= order.length; g++) {
    stack.push(...sourceRows.filter((r) => gapOf.get(r) === g));
    if (g < order.length) stack.push(order[g]);
  }

  // ---- own order, pass 2: parts with no role and anything the deviations moved (graphic objects as a whole) ----------
  const refs = useKeys.map((keys) => (keys ? keys.map((k) => drafts.get(k)!) : null));
  input.uses.forEach((s, symbolIdx) => {
    const mine = refs[symbolIdx];
    if (!s || !mine || s.library || s.origin === "graphic") return;
    const colourOrder = [...new Set(s.uses.map((u) => u.colour))].sort((a, b) => b - a);
    let ceiling: Draft | null = null;
    for (const c of colourOrder) {
      let lowest: Draft | null = null;
      s.uses.forEach((u, k) => {
        if (u.colour !== c) return;
        if (ceiling && stack.indexOf(mine[k]) > stack.indexOf(ceiling)) {
          const from = mine[k];
          const key = `${from.key}|under:${ceiling.key}`;
          let d = drafts.get(key);
          if (!d) {
            d = draft(key, { source: from.source, role: from.role, place: from.place, origin: "use", base: null, sourceOrdered: from.sourceOrdered, ownOrder: true, suffix: from.suffix });
            stack.splice(stack.indexOf(ceiling), 0, d);
          }
          mine[k] = d;
        }
        if (!lowest || stack.indexOf(mine[k]) < stack.indexOf(lowest)) lowest = mine[k];
      });
      if (lowest && (!ceiling || stack.indexOf(lowest) < stack.indexOf(ceiling))) ceiling = lowest;
    }
  });
  // Counts follow the references, objects what is drawn (row I5): a library-drawn symbol's objects on the rows carrying
  // its entry's ids, not on its own references' rows. A use row left with no reference and no palette id is dropped.
  for (const d of drafts.values()) {
    d.symbols = new Set();
    d.objects = 0;
    d.graphicObjects = 0;
  }
  refs.forEach((mine, symbolIdx) => {
    const s = input.uses[symbolIdx];
    if (!mine || !s) return;
    for (const d of new Set(mine)) {
      d.symbols.add(symbolIdx);
      if (s.library) continue;
      d.objects += s.objects;
      if (s.origin === "graphic") d.graphicObjects += s.objects;
    }
    if (s.library) {
      for (const id of libraryIdsOf(s)) {
        const c = carrier.get(id);
        if (c) c.objects += s.objects;
      }
    }
  });
  const isCarrier = (d: Draft) => d.role !== null && carrier.get(d.role) === d;
  const ordered = stack.filter((d) => d.origin !== "use" || d.symbols.size > 0 || isCarrier(d));
  const rowOf = new Map<Draft, number>(ordered.map((d, i) => [d, i]));

  // ---- output ------------------------------------------------------------------------------------------------------
  // The course purples' ink: the map's most used purple candidate, ties to the highest index (C9, C15).
  let purpleInk: number | null = null;
  for (const info of infos) {
    if (!isCoursePurple(info.paletteId)) continue;
    if (purpleInk === null || usage[info.index] >= usage[purpleInk]) purpleInk = info.index;
  }

  // A moved part's row: `<suffix>/under<n>`, numbered per colour and suffix bottom first.
  const underN = new Map<string, number>();
  const suffixOf = new Map<Draft, string>();
  for (const d of ordered) {
    if (!d.ownOrder) suffixOf.set(d, d.suffix);
    else {
      const n = (underN.get(`${d.source}|${d.suffix}`) ?? 0) + 1;
      underN.set(`${d.source}|${d.suffix}`, n);
      suffixOf.set(d, `${d.suffix}/under${n}`);
    }
  }
  const seenSource = new Set<number>();
  const out: DocumentColour[] = ordered.map((d) => {
    if (d.source === null) {
      const p = paletteById.get(d.role!)!;
      // Every inserted purple of a course role (the course purples, ISSprOM's purple 50 %) takes the map's purple ink, as
      // §9.2 step 4 does (row I5, carried from I3), so a library symbol has one ink in both orders.
      const cmyk = p.purpleRole && purpleInk !== null ? colours[purpleInk].cmyk : p.cmyk;
      const entry: DocumentColour = { id: `${rowEdition(edition, p.id)}:${p.id}`, name: p.name, cmyk: [...cmyk] as DocumentColour["cmyk"], paletteIds: [p.id] };
      if (p.purpleRole) entry.purpleRole = p.purpleRole;
      return entry;
    }
    const src = colours[d.source];
    const entry: DocumentColour = { ...src, cmyk: [...src.cmyk] as DocumentColour["cmyk"] };
    delete entry.paletteIds;
    delete entry.purpleRole;
    // An id-only row is never the one keeping the colour's id: the colour's own rows keep their I4 ids.
    if (d.idOnly || seenSource.has(d.source)) entry.id = `${src.id}/${suffixOf.get(d)}`;
    if (!d.idOnly) seenSource.add(d.source);
    if (isCarrier(d)) {
      entry.paletteIds = [d.role!];
      const role = paletteById.get(d.role!)?.purpleRole;
      if (role) entry.purpleRole = role;
    }
    return entry;
  });

  const firstRow = new Array<number>(colours.length).fill(-1);
  ordered.forEach((d, i) => {
    if (d.source !== null && !d.idOnly && firstRow[d.source] < 0) firstRow[d.source] = i;
  });
  const symbols = refs.map((mine) => (mine ? mine.map((d) => rowOf.get(d)!) : null));

  const rows: ColourLayerRow[] = ordered.map((d, row) => ({
    row,
    source: d.source,
    role: d.role,
    place: d.place,
    origin: d.origin,
    objects: d.objects,
    symbols: d.symbols.size,
    graphicObjects: d.graphicObjects,
    sourceOrdered: d.sourceOrdered,
    ownOrder: d.ownOrder,
  }));
  const numberOf = (source: number): { sourceNumber?: number } => {
    const n = colours[source].sourceNumber;
    return n === undefined ? {} : { sourceNumber: n };
  };
  const split: ColourLayersReport["split"] = [];
  colours.forEach((_, i) => {
    const mine = rows.filter((r) => r.source === i);
    if (mine.length >= 2) split.push({ source: i, ...numberOf(i), roles: mine.map((r) => r.role) });
  });
  const lowerAt = ordered.findIndex((d) => d.origin === "insert" && d.role === "purple-lower");
  const sourceOrdered: ColourLayersReport["sourceOrdered"] = rows
    .filter((r) => r.sourceOrdered)
    .map((r) => ({ row: r.row, source: r.source!, ...numberOf(r.source!), reason: r.sourceOrdered!, role: r.role, objects: r.objects, aboveLowerPurple: r.row > lowerAt }));
  const noRole: ColourLayersReport["noRole"] = rows
    .filter((r) => r.origin === "use" && r.role === null && r.place)
    .map((r) => ({ row: r.row, source: r.source!, ...numberOf(r.source!), place: r.place!, objects: r.objects }));
  const deviations: ColourDeviation[] = [...devs.entries()]
    .map(([key, acc]) => {
      const e: ColourDeviation = { upper: acc.upper, lower: acc.lower, kept: keep.has(key), byDefault: override[key] === undefined, objects: { upper: sumObjects(acc.upperRows), lower: sumObjects(acc.lowerRows) } };
      if (keep.has(key) && implied.has(key)) e.impliedBy = [...implied.get(key)!].sort();
      if (blocked.has(key)) e.blockedBy = [...blocked.get(key)!].sort();
      return e;
    })
    .sort((a, b) => b.objects.upper + b.objects.lower - (a.objects.upper + a.objects.lower) || (deviationKey(a.upper, a.lower) < deviationKey(b.upper, b.lower) ? -1 : 1));
  const inserted = rows.filter((r) => r.origin === "insert").map((r) => r.role!);

  return { colours: out, reindex: { symbols, colours: firstRow }, report: { rows, split, sourceOrdered, noRole, deviations, inserted, aliased, purpleInk } };
}

/** A cycle of `edges` (a → its set: a under each), as a list of nodes, or null. Deterministic: nodes in `nodes` order. */
function findCycle<T>(nodes: readonly T[], edges: ReadonlyMap<T, ReadonlySet<T>>): T[] | null {
  const state = new Map<T, 1 | 2>();
  const path: T[] = [];
  const visit = (n: T): T[] | null => {
    state.set(n, 1);
    path.push(n);
    for (const m of edges.get(n) ?? []) {
      const s = state.get(m);
      if (s === 1) return path.slice(path.indexOf(m));
      if (s === undefined) {
        const c = visit(m);
        if (c) return c;
      }
    }
    path.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of nodes) {
    if (state.has(n)) continue;
    const c = visit(n);
    if (c) return c;
  }
  return null;
}

/**
 * The nodes in an order that keeps every edge (a under b) and otherwise
 * stays closest to the base order: bottom-up, the next node is the one whose
 * lowest base key among itself and everything that must stand over it is
 * the lowest — so a row the source draws under a kept deviation's upper
 * sinks to just under it, and nothing rises.
 */
function sortByEdges<T>(nodes: readonly T[], edges: ReadonlyMap<T, ReadonlySet<T>>, key: (n: T) => Key, cmp: (a: T, b: T) => number): T[] {
  // eff(n) = the lowest base key over n and every node reachable from it (the nodes over it).
  const eff = new Map<T, Key>();
  const visit = (n: T): Key => {
    const known = eff.get(n);
    if (known) return known;
    let k = key(n);
    eff.set(n, k);
    for (const m of edges.get(n) ?? []) {
      const km = visit(m);
      if (cmpKey(km, k) < 0) k = km;
    }
    eff.set(n, k);
    return k;
  };
  nodes.forEach(visit);
  const indeg = new Map<T, number>(nodes.map((n) => [n, 0]));
  for (const n of nodes) for (const m of edges.get(n) ?? []) indeg.set(m, indeg.get(m)! + 1);
  const ready = nodes.filter((n) => indeg.get(n) === 0);
  const pick = (a: T, b: T) => cmpKey(eff.get(a)!, eff.get(b)!) || cmp(a, b);
  const out: T[] = [];
  while (ready.length) {
    ready.sort(pick);
    const n = ready.shift()!;
    out.push(n);
    for (const m of edges.get(n) ?? []) {
      indeg.set(m, indeg.get(m)! - 1);
      if (indeg.get(m) === 0) ready.push(m);
    }
  }
  if (out.length !== nodes.length) throw new ColourLayersError("the order's constraints have a cycle");
  return out;
}
