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
import { type PaletteEdition, paletteFor, type SpecId } from "../symbol-library/palette.js";
import { type ColourClass, classifyColour, type ClassifiedColour, paletteClass, paletteEntryFor, sameClass } from "./colour-class.js";

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
  for (const info of infos) {
    const c = colours[info.index];
    if (!info.class) continue;
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
  const topBlack = Math.max(-1, ...infos.filter((i) => i.class?.hue === "black" && i.class.percent >= 85).map((i) => i.index));
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
  /** Objects per source colour index — picks among duplicate source colours. */
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
}

type Slot = { kind: "source"; index: number } | { kind: "palette"; id: string };

export function alignColourStack(input: AlignmentInput): AlignmentResult {
  const { colours, infos, spec, edition } = input;
  const usage = (i: number) => input.usage?.[i] ?? 0;
  const palette = paletteFor(edition, spec);
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
  for (const id of [...needed].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))) {
    if (!rank.has(id)) continue; // not in this spec's palette; the resolver will report it
    if (placed.has(id)) continue;
    const cls = paletteClass(id, edition);
    if (cls && cls.hue !== "purple") {
      let best: number | undefined;
      for (const info of infos) {
        if (!info.paletteId || !sameClass(info.class, cls)) continue;
        if (best === undefined || better(info.index, best)) best = info.index;
      }
      if (best !== undefined) {
        placed.set(id, best);
        if (!standsFor.has(best)) standsFor.set(best, new Set());
        standsFor.get(best)!.add(id);
        const via = infos[best].paletteId!;
        const entry: AlignmentResult["aliased"][number] = { paletteId: id, viaPaletteId: via };
        if (colours[best].sourceNumber !== undefined) entry.sourceNumber = colours[best].sourceNumber;
        aliased.push(entry);
        continue;
      }
    }
    toInsert.push(id);
  }

  // Step 3b/4: insert in palette order, each next to its nearest already-placed neighbour.
  const stack: Slot[] = colours.map((_, index) => ({ kind: "source", index }));
  const posOf = (id: string): number => {
    const src = placed.get(id);
    return stack.findIndex((s) => (s.kind === "source" ? s.index === src : s.id === id));
  };
  const positioned = new Set<string>(placed.keys());
  const inserted: string[] = [];
  for (const id of toInsert) {
    const r = rank.get(id)!;
    let at: number;
    if (id === "purple-upper") {
      at = stack.length;
    } else if (id === "purple-lower") {
      // Directly below the first source colour the palette puts above lower purple.
      const above = stack.findIndex((s) => s.kind === "source" && [...(standsFor.get(s.index) ?? [])].some((p) => (rank.get(p) ?? -1) > r));
      at = above < 0 ? stack.length : above;
    } else {
      let lower: string | undefined, upper: string | undefined;
      for (const p of positioned) {
        const pr = rank.get(p);
        if (pr === undefined) continue;
        if (pr < r && (lower === undefined || pr > rank.get(lower)!)) lower = p;
        if (pr > r && (upper === undefined || pr < rank.get(upper)!)) upper = p;
      }
      if (lower !== undefined) at = posOf(lower) + 1;
      else if (upper !== undefined) at = posOf(upper);
      else at = stack.length;
    }
    stack.splice(at, 0, { kind: "palette", id });
    positioned.add(id);
    inserted.push(id);
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
      const entry: DocumentColour = { id: `${edition}:${p.id}`, name: p.name, cmyk: [...cmyk] as [number, number, number, number], paletteIds: [p.id] };
      if (p.purpleRole) entry.purpleRole = p.purpleRole;
      index.set(p.id, newIdx);
      out.push(entry);
    }
  }

  // Step 5: palette ids whose relative order in the stack disagrees with the palette (source order kept).
  const conflicts: AlignmentResult["conflicts"] = [];
  const ordered = [...index.entries()].filter(([id]) => rank.has(id)).sort((a, b) => a[1] - b[1]);
  const ranks = ordered.map(([id]) => rank.get(id)!);
  const keep = longestIncreasingSubsequence(ranks);
  ordered.forEach(([id, pos], i) => {
    if (keep.has(i)) return;
    const other = ordered.find(([oid, opos], j) => keep.has(j) && rank.get(oid)! > rank.get(id)! && opos < pos)
      ?? ordered.find(([oid, opos], j) => keep.has(j) && rank.get(oid)! < rank.get(id)! && opos > pos);
    conflicts.push({ colour: id, reason: other ? `source places ${id} ${other[1] < pos ? "above" : "below"} ${other[0]}; the palette has the reverse order` : "out of palette order" });
  });

  return { colours: out, remap, index, inserted, aliased, conflicts };
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
