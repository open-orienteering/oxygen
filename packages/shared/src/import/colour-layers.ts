/**
 * The layered colour stack (docs/map-symbols.md §9.3 "Layers"; slice I
 * row I3): the document's colours as one row per (source colour, role),
 * in the IOF palette's order instead of the mapper's table. A source
 * colour that serves several roles (brown 50 % as paved area and road
 * infill) becomes several rows with the same ink, and each symbol's
 * `render` is re-indexed per reference, so every part draws on its own
 * layer. `header.colours` stays "index = draw order": the renderers, the
 * course layer and materialisation read it as before.
 *
 * Pure. Nothing in the importer calls it yet (row I5); the colour-order
 * harness takes it as its candidate. Row I4 adds the source-order
 * exceptions (masks, graphic objects, uses with no role) and the
 * deviations; until then a use with no role is placed by its symbol's
 * kind.
 */

import type { DocumentColour, DocumentSymbol, SymbolMatch } from "../map-document/header.js";
import type { RenderSymbol } from "../render/symbol.js";
import { type PaletteEdition, palettes, type SpecId } from "../symbol-library/palette.js";
import { alignmentPalette, OVERLAY_STACK_IDS, type SourceColourInfo } from "./colour-align.js";
import { nameKind, paletteClass, sameClass, SKI_PALETTE_IDS } from "./colour-class.js";
import { colourRoles, type RoleColourInfo, type RolePalette } from "./colour-roles.js";

/** Where a row with no role goes until I4's source order: an area's at the top of the area block, any other under upper purple. */
export type NoRolePlace = "area" | "other";

/** The uses of one document symbol, as `buildColourLayers` reads them. */
export interface LayerSymbolUses {
  /** Objects drawn with the symbol (hidden symbols included, as stage 7's `usage`). */
  objects: number;
  /** `render.type`: what a use with no role is placed by. */
  type: RenderSymbol["type"];
  /** The symbol's origin; I4 places graphic objects' colours by the source order. */
  origin: NonNullable<DocumentSymbol["origin"]>;
  /** Every colour reference of the render in `renderColourPaths` order, with its role (`colourRoles`). */
  uses: readonly { colour: number; role: string | null }[];
}

/** A document symbol as `symbolColourUses` reads it. */
export interface LayerSymbol {
  render?: RenderSymbol | null;
  match?: Pick<SymbolMatch, "canonicalId"> | null;
  origin?: DocumentSymbol["origin"];
}

/**
 * The uses of every document symbol (`null` for a symbol without a render):
 * `colourRoles` per symbol, with its object count, kind and origin.
 * Throws on a reference outside the colour table.
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
    return { objects: objectsPerSymbol[i] ?? 0, type: s.render.type, origin: s.origin ?? "source", uses };
  });
}

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
  | "unreferenced";

export interface ColourLayerRow {
  /** Index in the layered stack (= draw order). */
  row: number;
  /** Source colour index; `null` for an inserted row. */
  source: number | null;
  /** Palette id of the alignment palette; `null`: no role. */
  role: string | null;
  /** For a row with no role: where it was placed. */
  place: NoRolePlace | null;
  origin: LayerOrigin;
  /** Objects drawn in the row (a symbol counts once per row it references). */
  objects: number;
  /** Symbols referencing the row. */
  symbols: number;
  /** Objects of `origin: "graphic"` symbols among `objects` (I4 places those by the source order). */
  graphicObjects: number;
}

export interface ColourLayersReport {
  /** Every row, bottom first. */
  rows: ColourLayerRow[];
  /** Source colours on several rows, with their rows' roles bottom first (`null`: no role). */
  split: { source: number; sourceNumber?: number; roles: (string | null)[] }[];
  /** Rows of uses with no role, bottom first. */
  noRole: { row: number; source: number; sourceNumber?: number; place: NoRolePlace; objects: number }[];
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

interface Draft {
  source: number | null;
  role: string | null;
  place: NoRolePlace | null;
  origin: LayerOrigin;
  objects: number;
  graphicObjects: number;
  symbols: Set<number>;
}

/**
 * Builds the layered stack (docs/map-symbols.md §9.3 "Layers"):
 *
 * - one row per (source colour, role) that a symbol references, zero-object
 *   symbols included; a use with no role is keyed by its place instead;
 * - rows ordered by their role's place in `alignmentPalette(edition, spec)`;
 *   rows of one role in source order; a use with no role by kind — an area
 *   directly under the ISSkiOM mask row (`white-skio`, which stays directly
 *   under lower purple), anything else directly under upper purple;
 * - each palette id on exactly one row (`paletteIds`): of its rows the one
 *   with the most objects, ties to the lowest source index; a needed id no
 *   row has is aliased to the most used identified source colour of its
 *   class (a row of its own), else inserted with the palette's CMYK;
 *   purples and ISSkiOM's rows never alias;
 * - lower and upper purple always inserted at their palette places, above
 *   any source row of the same role, in the ink of the map's most used
 *   course-purple candidate (ties to the highest index), else the
 *   palette's; the overlay's rows (`OVERLAY_STACK_IDS`) always present;
 * - a source colour no symbol references kept once, at the place of the
 *   palette id §9.1 identified it as (course purples excepted), else by
 *   the kind its name states;
 * - ids: a source colour's lowest row keeps its id, its other rows are
 *   `<id>/<paletteId>` or `<id>/none:<place>`; inserted rows
 *   `<edition>:<paletteId>`. Split rows keep the colour's name, CMYK,
 *   `sourceNumber`, spot and overprint.
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

  // Rows of uses, keyed by (colour, role) or (colour, place).
  const drafts = new Map<string, Draft>();
  const rowOfUse: (string[] | null)[] = [];
  const usage = new Array<number>(colours.length).fill(0);
  input.uses.forEach((s, symbolIdx) => {
    if (!s) {
      rowOfUse.push(null);
      return;
    }
    const keys: string[] = [];
    const counted = new Set<number>();
    for (const u of s.uses) {
      if (!Number.isInteger(u.colour) || u.colour < 0 || u.colour >= colours.length) throw new Error(`buildColourLayers: symbol ${symbolIdx} references colour index ${u.colour} outside the ${colours.length}-entry colour table`);
      const role = u.role !== null && rank.has(u.role) ? u.role : null;
      const place: NoRolePlace | null = role ? null : s.type === "area" ? "area" : "other";
      const key = `${u.colour}|${role ?? `none:${place}`}`;
      let d = drafts.get(key);
      if (!d) {
        d = { source: u.colour, role, place, origin: "use", objects: 0, graphicObjects: 0, symbols: new Set() };
        drafts.set(key, d);
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
      keys.push(key);
    }
    rowOfUse.push(keys);
  });

  // Source colours no symbol references: kept once, at their identified place.
  const hasRow = new Set([...drafts.values()].map((d) => d.source));
  colours.forEach((c, i) => {
    if (hasRow.has(i)) return;
    const id = infos[i]?.paletteId;
    const role = id && !isCoursePurple(id) && rank.has(id) ? id : null;
    const place: NoRolePlace | null = role ? null : nameKind(c.name) === "area" ? "area" : "other";
    drafts.set(`${i}|${role ?? `none:${place}`}`, { source: i, role, place, origin: "unreferenced", objects: 0, graphicObjects: 0, symbols: new Set() });
  });

  // Which row carries each palette id: the most objects, ties to the lowest source index; the course purples are always inserted.
  const carrier = new Map<string, Draft>();
  const better = (a: Draft, b: Draft) => a.objects > b.objects || (a.objects === b.objects && a.source! < b.source!);
  for (const d of drafts.values()) {
    if (!d.role || isCoursePurple(d.role)) continue;
    const cur = carrier.get(d.role);
    if (!cur || better(d, cur)) carrier.set(d.role, d);
  }

  // Needed ids no row has: alias to a same-class identified source colour, else insert (§9.2 steps 3–4).
  const aliased: ColourLayersReport["aliased"] = [];
  const wanted = new Set<string>([...input.needed, ...COURSE_PURPLES, ...OVERLAY_STACK_IDS]);
  const byRank = [...wanted].filter((id) => rank.has(id)).sort((a, b) => rank.get(a)! - rank.get(b)!);
  for (const id of byRank) {
    if (carrier.has(id)) continue;
    const cls = paletteClass(id, rowEdition(edition, id));
    let via: number | undefined;
    if (cls && cls.hue !== "purple" && !SKI_PALETTE_IDS.has(id)) {
      for (const info of infos) {
        if (!info.paletteId || SKI_PALETTE_IDS.has(info.paletteId) || !sameClass(info.class, cls)) continue;
        if (via === undefined || usage[info.index] > usage[via] || (usage[info.index] === usage[via] && info.index < via)) via = info.index;
      }
    }
    const d: Draft = { source: via ?? null, role: id, place: null, origin: via === undefined ? "insert" : "alias", objects: 0, graphicObjects: 0, symbols: new Set() };
    drafts.set(via === undefined ? `insert|${id}` : `${via}|${id}`, d);
    carrier.set(id, d);
    if (via !== undefined) {
      const e: ColourLayersReport["aliased"][number] = { paletteId: id, viaPaletteId: infos[via].paletteId! };
      if (colours[via].sourceNumber !== undefined) e.sourceNumber = colours[via].sourceNumber;
      aliased.push(e);
    }
  }

  // Order: the role's rank; a row with no role by place; ties by source index, inserted rows on top of their role.
  const areaKey = rank.get("white-skio")! - 0.5;
  const otherKey = rank.get("purple-upper")! - 0.5;
  const keyOf = (d: Draft) => (d.role ? rank.get(d.role)! : d.place === "area" ? areaKey : otherKey);
  const sourceKey = (d: Draft) => d.source ?? colours.length; // an inserted row above the source rows of its role
  const ordered = [...drafts.values()].sort((a, b) => keyOf(a) - keyOf(b) || sourceKey(a) - sourceKey(b));
  const rowOf = new Map<Draft, number>(ordered.map((d, i) => [d, i]));

  // The course purples' ink: the map's most used purple candidate, ties to the highest index (C9, C15).
  let purpleInk: number | null = null;
  for (const info of infos) {
    if (!isCoursePurple(info.paletteId)) continue;
    if (purpleInk === null || usage[info.index] >= usage[purpleInk]) purpleInk = info.index;
  }

  const seenSource = new Set<number>();
  const out: DocumentColour[] = ordered.map((d) => {
    const isCarrier = d.role !== null && carrier.get(d.role) === d;
    if (d.source === null) {
      const p = paletteById.get(d.role!)!;
      const cmyk = isCoursePurple(p.id) && purpleInk !== null ? colours[purpleInk].cmyk : p.cmyk;
      const entry: DocumentColour = { id: `${rowEdition(edition, p.id)}:${p.id}`, name: p.name, cmyk: [...cmyk] as DocumentColour["cmyk"], paletteIds: [p.id] };
      if (p.purpleRole) entry.purpleRole = p.purpleRole;
      return entry;
    }
    const src = colours[d.source];
    const entry: DocumentColour = { ...src, cmyk: [...src.cmyk] as DocumentColour["cmyk"] };
    delete entry.paletteIds;
    delete entry.purpleRole;
    if (seenSource.has(d.source)) entry.id = `${src.id}/${d.role ?? `none:${d.place}`}`;
    seenSource.add(d.source);
    if (isCarrier) {
      entry.paletteIds = [d.role!];
      const role = paletteById.get(d.role!)?.purpleRole;
      if (role) entry.purpleRole = role;
    }
    return entry;
  });

  const firstRow = new Array<number>(colours.length).fill(-1);
  ordered.forEach((d, i) => {
    if (d.source !== null && firstRow[d.source] < 0) firstRow[d.source] = i;
  });
  const symbols = rowOfUse.map((keys) => (keys ? keys.map((k) => rowOf.get(drafts.get(k)!)!) : null));

  const rows: ColourLayerRow[] = ordered.map((d, row) => ({ row, source: d.source, role: d.role, place: d.place, origin: d.origin, objects: d.objects, symbols: d.symbols.size, graphicObjects: d.graphicObjects }));
  const split: ColourLayersReport["split"] = [];
  colours.forEach((c, i) => {
    const mine = rows.filter((r) => r.source === i);
    if (mine.length < 2) return;
    const e: ColourLayersReport["split"][number] = { source: i, roles: mine.map((r) => r.role) };
    if (c.sourceNumber !== undefined) e.sourceNumber = c.sourceNumber;
    split.push(e);
  });
  const noRole: ColourLayersReport["noRole"] = rows
    .filter((r) => r.origin === "use" && r.role === null)
    .map((r) => {
      const e: ColourLayersReport["noRole"][number] = { row: r.row, source: r.source!, place: r.place!, objects: r.objects };
      const n = colours[r.source!].sourceNumber;
      if (n !== undefined) e.sourceNumber = n;
      return e;
    });
  const inserted = rows.filter((r) => r.origin === "insert").map((r) => r.role!);

  return { colours: out, reindex: { symbols, colours: firstRow }, report: { rows, split, noRole, inserted, aliased, purpleInk } };
}
