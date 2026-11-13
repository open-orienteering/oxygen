/**
 * `@oxygen/shared` symbol library — the canonical IOF symbol sets authored
 * in the `RenderSymbol` IR (03 §6.4). Normative: docs/map-symbols.md.
 */

import type { RenderSymbol } from "../render/symbol.js";
import { ALIAS_SOURCE as ISOM_ALIAS_SOURCE, SV_SOURCE as ISOM_SV_SOURCE } from "./ISOM2017-2/common.js";
import { isom2017_2 } from "./ISOM2017-2/index.js";
import { SV_SOURCE as ISSPROM_SV_SOURCE } from "./ISSprOM2019-2/common.js";
import { issprom2019_2 } from "./ISSprOM2019-2/index.js";
import { SV_SOURCE as ISSKIOM_SV_SOURCE } from "./ISSkiOM2019/common.js";
import { isskiom2019 } from "./ISSkiOM2019/index.js";
import { type PaletteEdition, paletteIndex, paletteStack } from "./palette.js";
import { type LibraryEntry, type SymbolLibrary, parseSymbolLibrary, resolveEntry } from "./schema.js";

export * from "./palette.js";
export * from "./schema.js";

/**
 * Version of the library *data*. Bumped whenever an entry's render,
 * code or variant changes, or a name or alias the matcher reads
 * (docs/map-symbols.md §8.2); part of a document's identity (06 §4.2)
 * and stored on `map_documents.library_version`. 2026.10.2: Swedish
 * names and ISOM 2000 aliases (B7). 2026.10.3: drawing defects (B10) —
 * 509 / 509.1 railway white dashes over a black band with black ends,
 * 101.b / 103.b slope ticks to +y, 107 taper, 510 / 511 / 511.b pylons at
 * corners (510 bars ±0.37 mm), ISOM 111 orientated to north. 2026.10.4:
 * ISOM 704 control numbers upper purple (user decision 2026-10-24).
 * 2026.11.1: the ISSkiOM 2019 overlay (G20) matched on every document and
 * its palette rows in every stack (G21), so every stored document is
 * re-matched at the release.
 */
export const SYMBOL_LIBRARY_VERSION = "2026.11.1";

/**
 * Raw authored inputs, before validation (tests and tooling). The two base
 * libraries, then the ISSkiOM overlay (docs/map-symbols.md §12).
 */
export const symbolLibraryInputs = { "ISOM2017-2": isom2017_2, "ISSprOM2019-2": issprom2019_2, ISSkiOM2019: isskiom2019 } as const;
export type SymbolLibraryId = keyof typeof symbolLibraryInputs;

/** Where each library's Swedish names and aliases come from (docs/map-symbols.md §3); `null` = none (yet). */
export const symbolLibraryNameSources: Record<SymbolLibraryId, { sv: string | null; aliases: string | null }> = {
  "ISOM2017-2": { sv: ISOM_SV_SOURCE, aliases: ISOM_ALIAS_SOURCE },
  "ISSprOM2019-2": { sv: ISSPROM_SV_SOURCE, aliases: null },
  ISSkiOM2019: { sv: ISSKIOM_SV_SOURCE, aliases: null },
};

export function isSymbolLibraryId(id: string): id is SymbolLibraryId {
  return Object.prototype.hasOwnProperty.call(symbolLibraryInputs, id);
}

let cache: Map<SymbolLibraryId, SymbolLibrary> | undefined;

function all(): Map<SymbolLibraryId, SymbolLibrary> {
  if (!cache) {
    cache = new Map();
    for (const [id, input] of Object.entries(symbolLibraryInputs) as [SymbolLibraryId, unknown][]) {
      cache.set(id, parseSymbolLibrary(input));
    }
  }
  return cache;
}

export function listSymbolLibraries(): SymbolLibrary[] {
  return [...all().values()];
}

export function getSymbolLibrary(id: SymbolLibraryId): SymbolLibrary {
  const lib = all().get(id);
  if (!lib) throw new Error(`unknown symbol library ${id}`);
  return lib;
}

/** Entry by full id (`ISOM2017-2:516`, `ISOM2017-2:302.b`). */
export function getLibraryEntry(entryId: string): LibraryEntry | undefined {
  const sep = entryId.indexOf(":");
  if (sep < 0) return undefined;
  const lib = all().get(entryId.slice(0, sep) as SymbolLibraryId);
  return lib?.entries.find((e) => e.id === entryId);
}

/** An overlay library is offered beside a document's own library and is never one (docs/map-symbols.md §12). */
export function isOverlayLibrary(id: SymbolLibraryId): boolean {
  return getSymbolLibrary(id).kind === "overlay";
}

/**
 * The enlargement of a library's dimensions on a map at `1:mapScale`
 * (docs/map-symbols.md §12.2; 03 §6.6), unrounded. Without `scaleRules`:
 * `referenceScale / mapScale`. With them: the row set of the entry whose
 * heading is `code` (optional when the library has one row set), the row
 * nearest by ratio for an unlisted scale, a tie to the larger denominator.
 */
export function libraryFactor(libraryId: SymbolLibraryId, mapScale: number, code?: string): number {
  if (!Number.isFinite(mapScale) || mapScale <= 0) throw new Error(`libraryFactor: map scale must be a positive number, got ${mapScale}`);
  const library = getSymbolLibrary(libraryId);
  const rules = library.scaleRules;
  if (!rules) return library.referenceScale / mapScale;
  let group: string;
  if (code === undefined) {
    const groups = Object.keys(rules);
    if (groups.length !== 1) throw new Error(`libraryFactor: ${libraryId} needs an entry code (scale groups ${groups.join(", ")})`);
    group = groups[0];
  } else {
    const entry = library.entries.find((e) => e.code === code);
    if (!entry?.scaleGroup) throw new Error(`libraryFactor: ${libraryId} has no entry ${code}`);
    group = entry.scaleGroup;
  }
  let best = rules[group][0];
  let bestDistance = Infinity;
  for (const row of rules[group]) {
    const distance = Math.abs(Math.log(mapScale / row.mapScale));
    const tie = Math.abs(distance - bestDistance) <= 1e-9;
    if ((!tie && distance < bestDistance) || (tie && row.mapScale > best.mapScale)) {
      best = row;
      bestDistance = Math.min(distance, bestDistance);
    }
  }
  return best.factor;
}

/** All entries under one spec heading (the heading's drawing first, then variants). */
export function entriesForCode(libraryId: SymbolLibraryId, code: string): LibraryEntry[] {
  return getSymbolLibrary(libraryId).entries.filter((e) => e.code === code);
}

export interface MaterialisedLibrary {
  library: SymbolLibrary;
  edition: PaletteEdition;
  /** The spec's palette as a document colour stack, index 0 drawn first. */
  colours: ReturnType<typeof paletteStack>;
  /** `library.entries[i]` resolved to `symbols[i]`. */
  symbols: RenderSymbol[];
}

/** The whole library as a colour stack plus plain `RenderSymbol`s, ready for `symbolise`. */
export function materialiseLibrary(id: SymbolLibraryId, edition?: PaletteEdition): MaterialisedLibrary {
  const library = getSymbolLibrary(id);
  const ed = edition ?? library.palette;
  const index = paletteIndex(ed, library.spec);
  return { library, edition: ed, colours: paletteStack(ed, library.spec), symbols: library.entries.map((e) => resolveEntry(e, index)) };
}
