import type { AnchorDef, FilterToken } from "./types";

/**
 * Apply all filter tokens to a list of items.
 * Tokens AND together — every token must match for an item to be included.
 * Free text tokens (anchor="") match against all string-valued fields.
 */
export function applyFilters<T>(
  items: T[],
  tokens: FilterToken[],
  anchors: AnchorDef<T>[],
  freeTextFields?: (keyof T)[],
): T[] {
  if (tokens.length === 0) return items;

  const anchorMap = new Map(anchors.map((a) => [a.key, a]));

  return items.filter((item) =>
    tokens.every((token) => {
      if (token.anchor) {
        const anchor = anchorMap.get(token.anchor);
        if (!anchor) return true; // unknown anchor → don't filter
        return anchor.match(item, token.operator, token.value);
      }
      // Free text: match against designated string fields
      return matchFreeText(item, token.value, freeTextFields);
    }),
  );
}

function matchFreeText<T>(
  item: T,
  query: string,
  fields?: (keyof T)[],
): boolean {
  const lowerQuery = query.toLowerCase();
  const obj = item as Record<string, unknown>;

  if (fields) {
    return fields.some((f) => {
      const val = obj[f as string];
      if (typeof val === "string") return val.toLowerCase().includes(lowerQuery);
      if (typeof val === "number") return String(val).includes(query);
      return false;
    });
  }

  // Fallback: search all string/number values
  return Object.values(obj).some((val) => {
    if (typeof val === "string") return val.toLowerCase().includes(lowerQuery);
    if (typeof val === "number") return String(val).includes(query);
    return false;
  });
}
