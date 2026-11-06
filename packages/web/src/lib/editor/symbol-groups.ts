/**
 * The filter region's symbol list, grouped by what the user sees
 * (docs/course-editor.md §7, "filter region"; feedback 2026-11-06 item 5).
 *
 * A document lists every source symbol: a heading's variants, minimum-size
 * and tag-line versions, frames, legends and helpers. The inspector shows
 * one entry per heading instead — the heading of the symbol's applied
 * match (`601` for `601.b`), else the source code's base (`101` for
 * `101.1`) — and toggles all its members at once. Presentation only: the
 * stored `symbols` prop stays document symbol indices, so the layer and
 * print are untouched, and nothing is rewritten at import (research 03
 * §6.5: a match is a reviewable mapping, never a rewrite).
 *
 * Not listed: hidden symbols (OCAD's hidden status, OMAP helpers), symbols
 * no object uses, and `missing` symbols (drawn through a proxy, which a
 * region cannot pick) — none of them can change what a region hides.
 * Folded under "Other": headings outside the document's library (club
 * codes, frames, legends), `graphic` entries and rectangles.
 */

import { mapDocument, mapImport, symbolLibrary } from "@oxygen/shared";

type Header = Pick<mapDocument.MapDocumentHeader, "symbols" | "library">;

export interface SymbolGroup {
  /** The heading: a library code (`601`) or the source base code (`850`, `graphic`). */
  code: string;
  name: string;
  /** Document symbol indices, ascending. */
  members: number[];
  /** A heading of the document's library (or of an applied match). */
  library: boolean;
  /** Folded under "Other" (frames, legends, club codes, graphics). */
  other: boolean;
  /** What the entry shows: the library preview of the drawn entry, else the document symbol's own; null without a drawing. */
  swatch: { kind: "library"; canonicalId: string } | { kind: "document"; idx: number } | null;
  /** Lowercased text the search matches: heading, names in both languages, members' source codes and names. */
  search: string;
}

const CODE = /^\d{3}(\.\d{1,3})?$/;

/** The heading of a source code: `505.1` → `505`; non-numeric codes stay whole (`graphic`). */
const headingOfSource = (code: string): string => (CODE.test(code.trim()) ? mapImport.baseCode(code) : code.trim());

const isLibraryId = (id: string | undefined): id is symbolLibrary.SymbolLibraryId => !!id && symbolLibrary.isSymbolLibraryId(id);

function headingEntry(libraryId: string | undefined, code: string): symbolLibrary.LibraryEntry | undefined {
  if (!isLibraryId(libraryId)) return undefined;
  const entries = symbolLibrary.entriesForCode(libraryId, code);
  return entries.find((e) => e.variant === null) ?? entries[0];
}

const compareCodes = (a: string, b: string): number => {
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  if (Number.isFinite(na) !== Number.isFinite(nb)) return Number.isFinite(na) ? -1 : 1;
  return a.localeCompare(b);
};

/**
 * The document's symbols grouped by heading, "Other" last, each part in code
 * order. `objectsPerSymbol[i]`: how many objects use symbol `i` (unused
 * symbols are left out). `lang`: the UI language (`sv…` names Swedish).
 */
export function symbolGroups(header: Header, objectsPerSymbol: ArrayLike<number>, lang: string): SymbolGroup[] {
  const sv = lang.toLowerCase().startsWith("sv");
  const byCode = new Map<string, { members: number[]; applied: { idx: number; canonicalId: string }[]; libraryId?: string }>();
  header.symbols.forEach((s, i) => {
    if (s.hidden || s.origin === "missing" || !(objectsPerSymbol[i] > 0)) return;
    const match = mapDocument.isAppliedMatch(s.match) ? s.match : null;
    const entry = match ? symbolLibrary.getLibraryEntry(match.canonicalId) : undefined;
    const code = entry?.code ?? headingOfSource(s.code);
    let g = byCode.get(code);
    if (!g) byCode.set(code, (g = { members: [], applied: [] }));
    g.members.push(i);
    if (match && entry) {
      g.applied.push({ idx: i, canonicalId: match.canonicalId });
      g.libraryId ??= match.canonicalId.slice(0, match.canonicalId.indexOf(":"));
    }
  });

  const out: SymbolGroup[] = [];
  for (const [code, g] of byCode) {
    const heading = headingEntry(g.libraryId ?? header.library?.id, code);
    const applied = g.applied.length > 0;
    const syms = g.members.map((i) => header.symbols[i]);
    const drawn = applied ? g.applied.reduce((a, b) => (objectsPerSymbol[b.idx] > objectsPerSymbol[a.idx] ? b : a)) : null;
    const withRender = g.members.filter((i) => header.symbols[i].render);
    const most = withRender.length > 0 ? withRender.reduce((a, b) => (objectsPerSymbol[b] > objectsPerSymbol[a] ? b : a)) : null;
    const name = applied && heading ? (sv ? heading.name.sv : heading.name.en) : syms[0].name;
    out.push({
      code,
      name,
      members: g.members,
      library: !!heading,
      other: !applied && (!heading || syms.every((s) => s.kind === "rectangle" || s.origin === "graphic")),
      swatch: drawn ? { kind: "library", canonicalId: drawn.canonicalId } : most !== null ? { kind: "document", idx: most } : null,
      search: [code, name, heading?.name.en, heading?.name.sv, ...syms.flatMap((s) => [s.code, s.name])].filter(Boolean).join("\n").toLowerCase(),
    });
  }
  return out.sort((a, b) => Number(a.other) - Number(b.other) || compareCodes(a.code, b.code));
}

/** The groups the search `query` matches (all for an empty query). */
export function filterGroups(groups: SymbolGroup[], query: string): SymbolGroup[] {
  const q = query.trim().toLowerCase();
  return q ? groups.filter((g) => g.search.includes(q)) : groups;
}

/** Whether every member of `g` is picked, some, or none (an older region may hold part of a group). */
export function groupState(g: SymbolGroup, picked: ReadonlySet<number>): "all" | "some" | "none" {
  const n = g.members.filter((i) => picked.has(i)).length;
  return n === 0 ? "none" : n === g.members.length ? "all" : "some";
}

/** The picked indices after toggling `g`: a full group leaves, a partial or empty one is completed. */
export function toggleGroup(picked: readonly number[], g: SymbolGroup): number[] {
  const next = new Set(picked);
  const full = groupState(g, next) === "all";
  for (const i of g.members) if (full) next.delete(i); else next.add(i);
  return [...next].sort((a, b) => a - b);
}

/** The listed group holding document symbol `idx`, or null (hidden, unused, missing). */
export function groupOfSymbol(groups: readonly SymbolGroup[], idx: number): SymbolGroup | null {
  return groups.find((g) => g.members.includes(idx)) ?? null;
}
