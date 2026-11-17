/**
 * The symbol picker's view of `mapPalette` (docs/course-editor.md §13 "Symbol picker"; map-symbols.md §11.2): the
 * palette's groups cut to one kind and a search, and each item's swatch and key. Pure.
 */

import type { mapDocument } from "@oxygen/shared";
import type { SymbolGroup } from "../../../../lib/editor/symbol-groups";
import { symbolKey } from "./symbols";

type PaletteGroup = mapDocument.PaletteGroup;
type PaletteItem = mapDocument.PaletteItem;
export type PaletteKind = mapDocument.PaletteItemKind;

/**
 * The groups with only `kind`'s items, the headings whose `search` holds the query (trimmed, lowercased; empty: all);
 * headings and groups left without items dropped. Order is the palette's.
 */
export function paletteView(groups: readonly PaletteGroup[], kind: PaletteKind, query: string): PaletteGroup[] {
  const q = query.trim().toLowerCase();
  const out: PaletteGroup[] = [];
  for (const g of groups) {
    const headings = g.headings.flatMap((h) => {
      if (q && !h.search.includes(q)) return [];
      const entries = h.entries.filter((e) => e.kind === kind);
      return entries.length ? [{ ...h, entries }] : [];
    });
    if (headings.length) out.push({ ...g, headings });
  }
  return out;
}

/** An item's key (`doc:<i>` / `patch:<key>`): a library item and the patch symbol it becomes share it. */
export const itemKey = (item: Pick<PaletteItem, "ref">): string => symbolKey(item.ref);

/** The item with `key` in `groups`, or null. */
export function findItem(groups: readonly PaletteGroup[], key: string | null): PaletteItem | null {
  if (!key) return null;
  for (const g of groups) for (const h of g.headings) for (const e of h.entries) if (itemKey(e) === key) return e;
  return null;
}

/** The swatch an item shows (`swatchUrl`): the library preview of what it is drawn as, else the document symbol's own. */
export function paletteSwatch(item: PaletteItem): SymbolGroup["swatch"] {
  if (item.canonicalId) return { kind: "library", canonicalId: item.canonicalId };
  return "doc" in item.ref ? { kind: "document", idx: item.ref.doc } : null;
}

/** The name shown: Swedish when the UI is and the item has one. */
export const itemName = (item: Pick<PaletteItem, "name" | "nameSv">, lang: string): string =>
  lang.toLowerCase().startsWith("sv") && item.nameSv ? item.nameSv : item.name;
