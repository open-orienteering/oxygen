export const MAP_TEXT_PLACEHOLDERS = [
  "event",
  "course",
  "map",
  "variant",
  "classes",
  "scale",
  "length",
  "climb",
  "date",
  "controls",
] as const;

export type MapTextPlaceholder = (typeof MAP_TEXT_PLACEHOLDERS)[number];
export type MapTextValues = Partial<Record<MapTextPlaceholder, string>>;

const KNOWN = new Set<string>(MAP_TEXT_PLACEHOLDERS);

export function expandMapText(
  text: string,
  values: MapTextValues,
): string {
  return text.replace(/\{([a-z]+)\}/gi, (match, rawKey: string) => {
    const key = rawKey.toLowerCase();
    if (!KNOWN.has(key)) return match;
    return values[key as MapTextPlaceholder] ?? "";
  });
}

export function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
