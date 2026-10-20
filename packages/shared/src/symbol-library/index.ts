/**
 * `@oxygen/shared` symbol library — the canonical IOF symbol sets authored
 * in the `RenderSymbol` IR (03 §6.4). Normative: docs/map-symbols.md.
 */

import type { RenderSymbol } from "../render/symbol.js";
import { ALIAS_SOURCE as ISOM_ALIAS_SOURCE, SV_SOURCE as ISOM_SV_SOURCE } from "./ISOM2017-2/common.js";
import { isom2017_2 } from "./ISOM2017-2/index.js";
import { SV_SOURCE as ISSPROM_SV_SOURCE } from "./ISSprOM2019-2/common.js";
import { issprom2019_2 } from "./ISSprOM2019-2/index.js";
import { type PaletteEdition, paletteIndex, paletteStack } from "./palette.js";
import { type LibraryEntry, type SymbolLibrary, parseSymbolLibrary, resolveEntry } from "./schema.js";

export * from "./palette.js";
export * from "./schema.js";

/**
 * Version of the library *data*. Bumped whenever an entry's render,
 * code or variant changes; part of a document's identity (06 §4.2) and
 * stored on `map_documents.library_version`.
 */
export const SYMBOL_LIBRARY_VERSION = "2026.10.1";

/** Raw authored inputs, before validation (tests and tooling). */
export const symbolLibraryInputs = { "ISOM2017-2": isom2017_2, "ISSprOM2019-2": issprom2019_2 } as const;
export type SymbolLibraryId = keyof typeof symbolLibraryInputs;

/** Where each library's Swedish names and aliases come from (docs/map-symbols.md §3); `null` = none yet. */
export const symbolLibraryNameSources: Record<SymbolLibraryId, { sv: string; aliases: string | null }> = {
  "ISOM2017-2": { sv: ISOM_SV_SOURCE, aliases: ISOM_ALIAS_SOURCE },
  "ISSprOM2019-2": { sv: ISSPROM_SV_SOURCE, aliases: null },
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
