/**
 * Colour stack alignment (03 §6.3 steps 1–5; 06 stage 7).
 *
 * Starts from the source colour table in source order — the mapper's
 * knock-out order wins for everything they drew — identifies which IOF
 * palette entry each source colour *is*, inserts the palette entries
 * that matched canonical symbols need but the source lacks, places lower
 * and upper purple, and flags where the source order contradicts the
 * palette. Output: the document's colour stack with `paletteIds` on every
 * entry that stands for a palette colour, plus an old→new index map for
 * the source symbols' render IR.
 */

import type { DocumentColour } from "../map-document/header.js";
import { listSymbolLibraries } from "../symbol-library/index.js";
import { iof2024Palette, type PaletteEdition, type PaletteEntry, palettes, type SpecId } from "../symbol-library/palette.js";
import { colourRefs } from "../symbol-library/schema.js";
import { AREA_PALETTE_IDS, type ColourClass, classifyColour, type ClassifiedColour, nameKind, paletteClass, paletteEntryFor, sameClass, SKI_PALETTE_IDS, skiPaletteIdFor } from "./colour-class.js";

/**
 * The palette rows every aligned stack carries whether or not a match needs
 * them, so an ISSkiOM track can be drawn on any map (docs/map-symbols.md
 * §12.3, answer 8 widened), in insertion order.
 */
export const OVERLAY_STACK_IDS = ["green100-area", "white-skio", "orange-skio", "green-skio"] as const;

let overlayIdsCache: ReadonlySet<string> | undefined;
/** Every palette id an overlay library's entries draw with. */
function overlayPaletteIds(): ReadonlySet<string> {
  if (!overlayIdsCache) {
    const ids = new Set<string>(OVERLAY_STACK_IDS);
    for (const lib of listSymbolLibraries()) if (lib.kind === "overlay") for (const e of lib.entries) colourRefs(e.render, ids);
    overlayIdsCache = ids;
  }
  return overlayIdsCache;
}

/**
 * The rows alignment ranks, top first: the spec's rows plus every row an
 * overlay entry uses, in the palette's order; a row the edition lacks
 * (`orange-skio` in iof2022) is the 2024 row (docs/map-symbols.md §12.3).
 */
export function alignmentPalette(edition: PaletteEdition, spec: SpecId): PaletteEntry[] {
  const extra = overlayPaletteIds();
  const own = new Map(palettes[edition].map((p) => [p.id, p]));
  return iof2024Palette
    .filter((p) => p.specs.includes(spec) || extra.has(p.id))
    .map((p) => own.get(p.id) ?? p);
}

/** The edition an aligned row's id carries: its own, or 2024 for a row the edition lacks. */
const rowEdition = (edition: PaletteEdition, id: string): PaletteEdition => (palettes[edition].some((p) => p.id === id) ? edition : "iof2024");

export interface SourceColourInfo {
  index: number;
  class: ColourClass | null;
  nameMismatch: boolean;
  /** The palette entry this colour is (03 §6.3 step 2); undefined when none. */
  paletteId?: string;
  /** How the mapping was found. */
  via?: "name" | "class" | "position";
}

/** Classify every source colour and decide which palette entry it is. Purple roles come from names, else from position relative to black. */
export function identifySourceColours(colours: readonly DocumentColour[], spec: SpecId, edition: PaletteEdition): SourceColourInfo[] {
  const infos: SourceColourInfo[] = colours.map((c, index) => {
    const cl: ClassifiedColour = classifyColour(c);
    return { index, class: cl.class, nameMismatch: !!cl.nameMismatch };
  });
  const purple100: SourceColourInfo[] = [];
  const topBlack = Math.max(-1, ...infos.filter((i) => i.class?.hue === "black" && i.class.percent >= 85).map((i) => i.index));
  for (const info of infos) {
    const c = colours[info.index];
    if (!info.class) continue;
    // ISSkiOM's own rows first: a ski green is green 83 %, the same class as the area green (docs/map-symbols.md §9.1).
    const ski = skiPaletteIdFor(c, info.class, info.index > topBlack, edition);
    if (ski) {
      info.paletteId = ski.id;
      info.via = ski.via;
      continue;
    }
    if (info.class.hue === "purple" && info.class.percent >= 85) {
      const choice = paletteEntryFor(c, info.class, spec, edition);
      if (choice && choice.score > 0) {
        info.paletteId = choice.entry.id;
        info.via = "name";
      } else {
        purple100.push(info);
      }
      continue;
    }
    const choice = paletteEntryFor(c, info.class, spec, edition);
    if (choice) {
      info.paletteId = choice.entry.id;
      info.via = choice.score > 0 ? "name" : "class";
    }
  }
  // Unnamed full purples: above every black 100 % colour → upper, else lower.
  for (const info of purple100) {
    info.paletteId = info.index > topBlack ? "purple-upper" : "purple-lower";
    info.via = "position";
  }
  return infos;
}

export interface AlignmentInput {
  colours: readonly DocumentColour[];
  infos: readonly SourceColourInfo[];
  spec: SpecId;
  edition: PaletteEdition;
  /** Palette ids referenced by applied canonical matches. */
  needed: ReadonlySet<string>;
  /**
   * Objects per source colour index — picks among duplicate source colours;
   * colours no object uses neither steer lower purple nor raise its warnings.
   * Absent: every colour counts.
   */
  usage?: ArrayLike<number>;
}

export interface AlignmentResult {
  colours: DocumentColour[];
  /** Old source index → new index. */
  remap: number[];
  /** Palette id → new index for every id the stack now stands for. */
  index: Map<string, number>;
  inserted: string[];
  aliased: { paletteId: string; viaPaletteId: string; sourceNumber?: number }[];
  conflicts: { colour: string; reason: string }[];
  /** Area colours (palette area entries, or named "area" / "ytobjekt") drawn above lower purple: they hide the course overprint. */
  areasAboveLowerPurple: { name: string; sourceNumber?: number; paletteId?: string }[];
}

type Slot = { kind: "source"; index: number } | { kind: "palette"; id: string };

export function alignColourStack(input: AlignmentInput): AlignmentResult {
  const { colours, infos, spec, edition } = input;
  const usage = (i: number) => input.usage?.[i] ?? 0;
  const palette = alignmentPalette(edition, spec);
  // Palette rank: 0 = bottom of the stack (drawn first).
  const rank = new Map<string, number>();
  palette.slice().reverse().forEach((p, i) => rank.set(p.id, i));

  // Step 2: one source colour per palette id — the most used, ties to the lowest.
  const placed = new Map<string, number>();
  const standsFor = new Map<number, Set<string>>();
  const better = (a: number, b: number) => usage(a) > usage(b) || (usage(a) === usage(b) && a < b);
  for (const info of infos) {
    if (!info.paletteId) continue;
    const cur = placed.get(info.paletteId);
    if (cur === undefined || better(info.index, cur)) placed.set(info.paletteId, info.index);
  }
  for (const [id, idx] of placed) {
    if (!standsFor.has(idx)) standsFor.set(idx, new Set());
    standsFor.get(idx)!.add(id);
  }

  // Step 3a: a needed id the source lacks but has a same-class colour for → alias, not insert.
  const aliased: AlignmentResult["aliased"] = [];
  const toInsert: string[] = [];
  const needed = new Set(input.needed);
  needed.add("purple-lower");
  needed.add("purple-upper");
  // Step 3a for one id: true when a same-class source colour now stands for it. ISSkiOM's own rows never alias, nor are aliased to.
  const alias = (id: string): boolean => {
    const cls = paletteClass(id, rowEdition(edition, id));
    if (!cls || cls.hue === "purple" || SKI_PALETTE_IDS.has(id)) return false;
    let best: number | undefined;
    for (const info of infos) {
      if (!info.paletteId || SKI_PALETTE_IDS.has(info.paletteId) || !sameClass(info.class, cls)) continue;
      if (best === undefined || better(info.index, best)) best = info.index;
    }
    if (best === undefined) return false;
    placed.set(id, best);
    if (!standsFor.has(best)) standsFor.set(best, new Set());
    standsFor.get(best)!.add(id);
    const entry: AlignmentResult["aliased"][number] = { paletteId: id, viaPaletteId: infos[best].paletteId! };
    if (colours[best].sourceNumber !== undefined) entry.sourceNumber = colours[best].sourceNumber;
    aliased.push(entry);
    return true;
  };
  for (const id of [...needed].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))) {
    if (!rank.has(id)) continue; // not in this spec's palette; the resolver will report it
    if (placed.has(id)) continue;
    if (SKI_PALETTE_IDS.has(id)) continue; // placed by their own rules after lower purple (below)
    if (alias(id)) continue;
    toInsert.push(id);
  }

  // Which side of lower purple a slot belongs on (docs/map-symbols.md §9.2 step 4); null when it does not take part.
  const lowerRank = rank.get("purple-lower")!;
  const counts = (i: number) => !input.usage || usage(i) > 0;
  const sideOf = (s: Slot): Side => {
    if (s.kind === "palette") return paletteSide(s.id, rank, lowerRank);
    if (!counts(s.index)) return null;
    const id = infos[s.index]?.paletteId;
    if (id) return paletteSide(id, rank, lowerRank);
    return nameKind(colours[s.index].name) === "area" ? "below-area" : null;
  };

  // Step 3b/4: insert in palette order, each next to its nearest already-placed neighbour.
  const stack: Slot[] = colours.map((_, index) => ({ kind: "source", index }));
  const posOf = (id: string): number => {
    const src = placed.get(id);
    return stack.findIndex((s) => (s.kind === "source" ? s.index === src : s.id === id));
  };
  const positioned = new Set<string>(placed.keys());
  const inserted: string[] = [];
  const insert = (id: string, at: number) => {
    stack.splice(at, 0, { kind: "palette", id });
    positioned.add(id);
    inserted.push(id);
  };
  /** Directly above the nearest placed palette neighbour below it, else below the nearest one above it, else on top. */
  const byNeighbour = (id: string): number => {
    const r = rank.get(id)!;
    let lower: string | undefined, upper: string | undefined;
    for (const p of positioned) {
      const pr = rank.get(p);
      if (pr === undefined) continue;
      if (pr < r && (lower === undefined || pr > rank.get(lower)!)) lower = p;
      if (pr > r && (upper === undefined || pr < rank.get(upper)!)) upper = p;
    }
    if (lower !== undefined) return posOf(lower) + 1;
    if (upper !== undefined) return posOf(upper);
    return stack.length;
  };
  for (const id of toInsert) {
    if (id === "purple-upper") insert(id, stack.length);
    else if (id === "purple-lower") insert(id, lowerPurpleAnchor(stack.map(sideOf)));
    else insert(id, byNeighbour(id));
  }

  // The overlay's rows (docs/map-symbols.md §9.2 step 4, §12.3), after both purples so nothing placed above moves:
  // green 100 % area by steps 3–4 but never above lower purple; the track mask directly below lower purple;
  // the track inks directly below the first colour above lower purple that the palette ranks above them
  // (the upper overprint colours), else on top; orange under green.
  // Rows this loop inserts: placed by rule, not drawn by the mapper — step 5b leaves them out.
  const overlayInserted = new Set<string>();
  for (const id of OVERLAY_STACK_IDS) {
    if (positioned.has(id)) continue;
    if (id === "white-skio") insert(id, posOf("purple-lower"));
    else if (SKI_PALETTE_IDS.has(id)) {
      // Searched from lower purple up: a copy of the upper purple some tables keep at the bottom does not drag the tracks under the map.
      const r = rank.get(id)!;
      const from = posOf("purple-lower") + 1;
      const above = stack.slice(from).findIndex((slot) => {
        const ids = slot.kind === "palette" ? [slot.id] : [...(standsFor.get(slot.index) ?? []), infos[slot.index]?.paletteId];
        return ids.some((x) => x !== undefined && (rank.get(x) ?? -1) > r);
      });
      insert(id, above < 0 ? stack.length : from + above);
    } else if (alias(id)) {
      positioned.add(id);
      continue;
    }
    // An area row: never above lower purple, whatever stray area colour the source keeps on top.
    else insert(id, Math.min(byNeighbour(id), posOf("purple-lower")));
    overlayInserted.add(id);
  }

  // Build the new stack.
  const out: DocumentColour[] = [];
  const remap = new Array<number>(colours.length).fill(-1);
  const index = new Map<string, number>();
  const paletteById = new Map(palette.map((p) => [p.id, p]));
  for (const slot of stack) {
    const newIdx = out.length;
    if (slot.kind === "source") {
      const src = colours[slot.index];
      const ids = [...(standsFor.get(slot.index) ?? [])].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
      const entry: DocumentColour = { ...src };
      delete entry.paletteIds;
      delete entry.purpleRole;
      if (ids.length) {
        entry.paletteIds = ids;
        const role = ids.map((id) => paletteById.get(id)?.purpleRole).find(Boolean);
        if (role) entry.purpleRole = role;
        for (const id of ids) index.set(id, newIdx);
      }
      remap[slot.index] = newIdx;
      out.push(entry);
    } else {
      const p = paletteById.get(slot.id)!;
      // One course-overprint ink: an inserted purple copies the map's own purple of the other role (user decision 2026-10-24, C9).
      const sibling = p.purpleRole ? placed.get(p.id === "purple-upper" ? "purple-lower" : "purple-upper") : undefined;
      const cmyk = (sibling !== undefined ? colours[sibling].cmyk : p.cmyk);
      const entry: DocumentColour = { id: `${rowEdition(edition, p.id)}:${p.id}`, name: p.name, cmyk: [...cmyk] as [number, number, number, number], paletteIds: [p.id] };
      if (p.purpleRole) entry.purpleRole = p.purpleRole;
      index.set(p.id, newIdx);
      out.push(entry);
    }
  }

  // Step 5a: every counted colour against lower purple — the side the palette puts it on (source order kept).
  const conflicts: AlignmentResult["conflicts"] = [];
  const areasAboveLowerPurple: AlignmentResult["areasAboveLowerPurple"] = [];
  const lowerAt = stack.findIndex((s) => (s.kind === "palette" ? s.id === "purple-lower" : s.index === placed.get("purple-lower")));
  stack.forEach((slot, pos) => {
    const side = sideOf(slot);
    if (!side || pos === lowerAt || (side === "above") === (pos > lowerAt)) return;
    const id = slot.kind === "palette" ? slot.id : infos[slot.index]?.paletteId;
    const name = slot.kind === "palette" ? paletteById.get(slot.id)!.name : colours[slot.index].name;
    if (side === "below-area") {
      const e: AlignmentResult["areasAboveLowerPurple"][number] = { name };
      if (slot.kind === "source" && colours[slot.index].sourceNumber !== undefined) e.sourceNumber = colours[slot.index].sourceNumber;
      if (id) e.paletteId = id;
      areasAboveLowerPurple.push(e);
    } else {
      conflicts.push({ colour: id!, reason: `source places "${name}" ${side === "above" ? "below" : "above"} purple-lower; the palette has the reverse order` });
    }
  });

  // Step 5b: palette ids whose relative order in the stack disagrees with the palette (lower purple is 5a's).
  // The overlay's rows inserted above take no part, needed by a match or not: they are placed by rule, not
  // drawn by the mapper, so they neither are reported nor tip which source colours are (docs/map-symbols.md §9.2 step 5).
  const ordered = [...index.entries()].filter(([id]) => rank.has(id) && id !== "purple-lower" && !overlayInserted.has(id)).sort((a, b) => a[1] - b[1]);
  const ranks = ordered.map(([id]) => rank.get(id)!);
  const keep = longestIncreasingSubsequence(ranks);
  ordered.forEach(([id, pos], i) => {
    if (keep.has(i)) return;
    const other = ordered.find(([oid, opos], j) => keep.has(j) && rank.get(oid)! > rank.get(id)! && opos < pos)
      ?? ordered.find(([oid, opos], j) => keep.has(j) && rank.get(oid)! < rank.get(id)! && opos > pos);
    conflicts.push({ colour: id, reason: other ? `source places ${id} ${other[1] < pos ? "above" : "below"} ${other[0]}; the palette has the reverse order` : "out of palette order" });
  });

  return { colours: out, remap, index, inserted, aliased, conflicts, areasAboveLowerPurple };
}

/** "above": the palette draws it above lower purple; "below-area": an area colour; "below": any other colour the palette puts below. */
type Side = "above" | "below-area" | "below" | null;

function paletteSide(id: string, rank: ReadonlyMap<string, number>, lowerRank: number): Side {
  const r = rank.get(id);
  if (r === undefined || id === "purple-lower") return null;
  if (r > lowerRank) return "above";
  return AREA_PALETTE_IDS.has(id) ? "below-area" : "below";
}

/**
 * Where an inserted lower purple goes (docs/map-symbols.md §9.2 step 4):
 * the gap with the fewest misplaced colours — area colours above it plus
 * colours the palette puts above lower purple below it — then the fewest
 * areas above, then the fewest other below-purple colours (road infill and
 * outline) above, then the lowest gap: directly above the highest area
 * colour it keeps below. One stray colour (a dark-green "area" kept at the
 * bottom of the area block, a yellow on top of the stack) does not decide
 * the place. Without area colours: directly below the first colour the
 * palette puts above lower purple, else on top.
 */
function lowerPurpleAnchor(sides: readonly Side[]): number {
  if (!sides.includes("below-area")) {
    const above = sides.indexOf("above");
    return above < 0 ? sides.length : above;
  }
  // Gap g sits below sides[g]: colours at ≥ g end up above lower purple, those at < g below it.
  let areasAbove = sides.filter((s) => s === "below-area").length;
  let othersAbove = sides.filter((s) => s === "below").length;
  let aboveBelow = 0;
  const key = (): [number, number, number] => [areasAbove + aboveBelow, areasAbove, othersAbove];
  let best = { at: 0, key: key() };
  for (let g = 1; g <= sides.length; g++) {
    const s = sides[g - 1];
    if (s === "below-area") areasAbove--;
    else if (s === "below") othersAbove--;
    else if (s === "above") aboveBelow++;
    const k = key();
    const i = k.findIndex((v, j) => v !== best.key[j]);
    if (i >= 0 && k[i] < best.key[i]) best = { at: g, key: k };
  }
  return best.at;
}

function longestIncreasingSubsequence(values: number[]): Set<number> {
  const n = values.length;
  const len = new Array<number>(n).fill(1);
  const prev = new Array<number>(n).fill(-1);
  let bestEnd = -1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (values[j] <= values[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    }
    if (bestEnd < 0 || len[i] > len[bestEnd]) bestEnd = i;
  }
  const out = new Set<number>();
  for (let i = bestEnd; i >= 0; i = prev[i]) out.add(i);
  return out;
}

/** Palette id → stack index for an aligned stack (what the render bridge and the resolver use). */
export function paletteIndexOfStack(colours: readonly Pick<DocumentColour, "paletteIds">[]): Map<string, number> {
  const index = new Map<string, number>();
  colours.forEach((c, i) => { for (const id of c.paletteIds ?? []) index.set(id, i); });
  return index;
}
