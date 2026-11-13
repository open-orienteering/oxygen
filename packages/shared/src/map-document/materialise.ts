/**
 * Symbol materialisation and the Map mode palette (docs/map-symbols.md §11;
 * research 03 §1 scope note, 08 §4.7).
 *
 * `materialiseSymbol` places a library entry of any registered library in
 * a document: colours resolved through the document's aligned stack,
 * dimensions scaled to the document, as the `PatchSymbol` the event's patch
 * stores under the entry's full id (map-patches §1.3). `mapPalette` lists
 * what Map mode can draw with. Neither ever changes the colour stack.
 *
 * Pure TypeScript; no Node APIs.
 */

import { paletteIndexOfStack } from "../import/colour-align.js";
import { documentLibraryId } from "../import/decisions.js";
import { baseCode } from "../import/matcher.js";
import {
  entriesForCode,
  getLibraryEntry,
  getSymbolLibrary,
  isSymbolLibraryId,
  libraryFactor,
  type SymbolLibraryId,
} from "../symbol-library/index.js";
import { colourRefs, type LibraryEntry } from "../symbol-library/schema.js";
import type { MapDocument } from "./codec.js";
import type { DocumentSymbol, MapDocumentHeader } from "./header.js";
import { type MapPatch, type PatchSymbol, type PatchSymbolRef, patchSymbolSchema } from "./patch.js";
import { canonicalEntryRender, isAppliedMatch } from "./render-bridge.js";

// ---- materialisation (§11.1) ------------------------------------------------

export type MaterialiseResult =
  | { ok: true; key: string; symbol: PatchSymbol; factor: number }
  | { ok: false; reason: "unknown-entry" }
  | { ok: false; reason: "missing-colours"; missing: string[] };

/** The library an entry belongs to, from its full id. */
const libraryOfEntry = (entry: Pick<LibraryEntry, "id">): string => entry.id.slice(0, entry.id.indexOf(":"));

/**
 * The factor `entry` is scaled by on a document (map-symbols §11.1): the
 * document's own library at `documentFactor`; another library at
 * `libraryFactor(library, mapScale, code) × symbolScale`, with
 * `symbolScale = documentFactor ÷ libraryFactor(documentLibrary, mapScale)`
 * (1 when the document was never matched).
 */
export function materialiseFactor(header: Pick<MapDocumentHeader, "library" | "documentFactor" | "mapScale">, entry: LibraryEntry): number {
  const library = libraryOfEntry(entry);
  const own = header.library?.id;
  if (own === library) return header.documentFactor;
  if (!isSymbolLibraryId(library)) throw new Error(`materialiseFactor: unknown library ${library}`);
  const symbolScale = own && isSymbolLibraryId(own) ? header.documentFactor / libraryFactor(own, header.mapScale) : 1;
  return libraryFactor(library, header.mapScale, entry.code) * symbolScale;
}

/** The palette ids `entry` uses that the stack's index lacks, sorted. */
function missingColours(entry: LibraryEntry, index: ReadonlyMap<string, number>): string[] {
  return [...colourRefs(entry.render)].filter((id) => !index.has(id)).sort();
}

/**
 * A library entry of any registered library, by full id, materialised for
 * `doc` (map-symbols §11.1). Deterministic; never throws for an unknown id
 * or a missing colour — both are results.
 */
export function materialiseSymbol(doc: Pick<MapDocument, "header">, canonicalId: string): MaterialiseResult {
  const entry = getLibraryEntry(canonicalId);
  if (!entry) return { ok: false, reason: "unknown-entry" };
  const index = paletteIndexOfStack(doc.header.colours);
  const missing = missingColours(entry, index);
  if (missing.length > 0) return { ok: false, reason: "missing-colours", missing };
  const factor = materialiseFactor(doc.header, entry);
  const render = canonicalEntryRender(entry, index, factor);
  const symbol = patchSymbolSchema.parse({ code: entry.code, name: entry.name.en, kind: render.type, origin: "source", hidden: false, render });
  return { ok: true, key: entry.id, symbol, factor };
}

// ---- the palette (§11.2) ----------------------------------------------------

export type PaletteGroupId = "library" | "ISSkiOM2019" | "other";
export type PaletteItemKind = "point" | "line" | "area";

export interface PaletteItem {
  kind: PaletteItemKind;
  source: "document" | "patch" | "library";
  /** What an op references: the document's symbol, or the patch symbol key (filled by `materialiseSymbol` on first use). */
  ref: PatchSymbolRef;
  /** The library entry it is drawn as (the swatch); null = the document symbol's own drawing. */
  canonicalId: string | null;
  code: string;
  /** Source name, or the entry's English name. */
  name: string;
  nameSv?: string;
  /** Objects using it in the document; 0 for patch and library items. */
  objects: number;
  enabled: boolean;
  /** Palette ids the stack lacks, when not enabled. */
  missing?: string[];
}

export interface PaletteHeading {
  code: string;
  name: { en: string; sv?: string };
  entries: PaletteItem[];
  /** Lowercased text a search matches: code, names, every item's code and names. */
  search: string;
}

export interface PaletteGroup {
  id: PaletteGroupId;
  /** The document's library, the overlay, null for "other". */
  library: SymbolLibraryId | null;
  headings: PaletteHeading[];
}

const OVERLAY: SymbolLibraryId = "ISSkiOM2019";
const DRAWABLE_KINDS: ReadonlySet<string> = new Set(["point", "line", "area"]);
const SOURCE_CODE = /^\d{3}(\.\d{1,3})?$/;
const COURSE_CODE = /^7\d\d(\.|$)/;

/** A source code's heading: `505.1` → `505`; non-numeric codes stay whole (`graphic`). As P3's symbol list. */
const headingOfSource = (code: string): string => (SOURCE_CODE.test(code.trim()) ? baseCode(code) : code.trim());

/** Codes numerically where both are numeric, numeric first, else by string. */
export function compareSymbolCodes(a: string, b: string): number {
  const na = Number(a), nb = Number(b);
  const fa = Number.isFinite(na), fb = Number.isFinite(nb);
  if (fa && fb) return na - nb || (a < b ? -1 : a > b ? 1 : 0);
  if (fa !== fb) return fa ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Bucket {
  group: PaletteGroupId;
  code: string;
  /** Library the heading's name is taken from. */
  nameLibrary?: SymbolLibraryId;
  document: { item: PaletteItem; index: number }[];
  patch: PaletteItem[];
  libraryItems: PaletteItem[];
}

/**
 * What Map mode can draw with (map-symbols §11.2): the document's source
 * table through its matches, the patch's symbols, and the library entries
 * the document can materialise (disabled with their missing colours when it
 * cannot), grouped by heading. `doc` is the pinned document.
 */
export function mapPalette(doc: MapDocument, patch?: MapPatch | null): PaletteGroup[] {
  const { header } = doc;
  const docLibrary = documentLibraryId(header);
  const index = paletteIndexOfStack(header.colours);
  const groupOf = (library: string): PaletteGroupId => (library === docLibrary ? "library" : library === OVERLAY ? "ISSkiOM2019" : "other");

  const counts = new Array<number>(header.symbols.length).fill(0);
  for (let i = 0; i < header.objects.count; i++) {
    const s = doc.attrs.symbolIdx[i];
    if (s < counts.length) counts[s]++;
  }

  const buckets = new Map<string, Bucket>();
  const bucket = (group: PaletteGroupId, code: string, library?: string): Bucket => {
    const key = `${group}\u0000${code}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { group, code, document: [], patch: [], libraryItems: [] }));
    if (!b.nameLibrary && library && isSymbolLibraryId(library)) b.nameLibrary = library;
    return b;
  };
  /** Entries already offered by a document or patch item. */
  const covered = new Set<string>();

  header.symbols.forEach((s: DocumentSymbol, i) => {
    if (s.hidden || s.origin !== "source" || !DRAWABLE_KINDS.has(s.kind)) return;
    const entry = isAppliedMatch(s.match) ? getLibraryEntry(s.match.canonicalId) : undefined;
    if (!s.render && !entry) return;
    let b: Bucket;
    if (entry) {
      covered.add(entry.id);
      b = bucket(groupOf(libraryOfEntry(entry)), entry.code, libraryOfEntry(entry));
    } else {
      const code = headingOfSource(s.code);
      b = entriesForCode(docLibrary, code).length > 0 ? bucket("library", code, docLibrary) : bucket("other", code);
    }
    b.document.push({
      index: i,
      item: {
        kind: s.kind as PaletteItemKind,
        source: "document",
        ref: { doc: i },
        canonicalId: entry?.id ?? null,
        code: s.code,
        name: s.name,
        objects: counts[i],
        enabled: true,
      },
    });
  });

  for (const key of Object.keys(patch?.symbols ?? {}).sort()) {
    const sym = patch!.symbols[key];
    if (!DRAWABLE_KINDS.has(sym.kind)) continue;
    const entry = getLibraryEntry(key);
    if (entry) covered.add(entry.id);
    const b = entry ? bucket(groupOf(libraryOfEntry(entry)), entry.code, libraryOfEntry(entry)) : bucket("other", headingOfSource(sym.code));
    b.patch.push({
      kind: sym.kind as PaletteItemKind,
      source: "patch",
      ref: { patch: key },
      canonicalId: entry ? entry.id : null,
      code: sym.code,
      name: sym.name,
      ...(entry?.name.sv ? { nameSv: entry.name.sv } : {}),
      objects: 0,
      enabled: true,
    });
  }

  const offered: SymbolLibraryId[] = [docLibrary];
  if (index.has("green-skio") && docLibrary !== OVERLAY) offered.push(OVERLAY);
  for (const library of offered) {
    for (const entry of getSymbolLibrary(library).entries) {
      const kind = (entry.render as { type: string }).type;
      if (!DRAWABLE_KINDS.has(kind) || COURSE_CODE.test(entry.code) || covered.has(entry.id)) continue;
      const missing = missingColours(entry, index);
      bucket(groupOf(library), entry.code, library).libraryItems.push({
        kind: kind as PaletteItemKind,
        source: "library",
        ref: { patch: entry.id },
        canonicalId: entry.id,
        code: entry.code,
        name: entry.name.en,
        ...(entry.name.sv ? { nameSv: entry.name.sv } : {}),
        objects: 0,
        enabled: missing.length === 0,
        ...(missing.length > 0 ? { missing } : {}),
      });
    }
  }

  const groups: PaletteGroup[] = [];
  for (const id of ["library", "ISSkiOM2019", "other"] as const) {
    const headings: PaletteHeading[] = [];
    for (const b of buckets.values()) {
      if (b.group !== id) continue;
      const documentItems = b.document
        .sort((x, y) => Number(y.item.canonicalId !== null) - Number(x.item.canonicalId !== null) || y.item.objects - x.item.objects || x.index - y.index)
        .map((d) => d.item);
      const entries = [...documentItems, ...b.patch, ...b.libraryItems];
      const headingEntries = b.nameLibrary ? entriesForCode(b.nameLibrary, b.code) : [];
      const headingEntry = headingEntries.find((e) => e.variant === null) ?? headingEntries[0];
      const name = headingEntry ? { en: headingEntry.name.en, ...(headingEntry.name.sv ? { sv: headingEntry.name.sv } : {}) } : { en: entries[0].name };
      const search = [b.code, name.en, name.sv, ...entries.flatMap((e) => [e.code, e.name, e.nameSv])]
        .filter((t): t is string => !!t)
        .join("\n")
        .toLowerCase();
      headings.push({ code: b.code, name, entries, search });
    }
    if (headings.length === 0) continue;
    headings.sort((a, b) => compareSymbolCodes(a.code, b.code));
    groups.push({ id, library: id === "library" ? docLibrary : id === "ISSkiOM2019" ? OVERLAY : null, headings });
  }
  return groups;
}
