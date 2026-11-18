/**
 * Pure helpers of the review page's colour panel (docs/map-symbols.md
 * §8.7 "Colour layers"; `mapImport.review` → `colour`).
 */

export type ColourOrder = "iof" | "source";

/** The fields of a layer row the panel reads (the API's `ColourLayerView`). */
export interface ColourLayerLike {
  row: number;
  role: string | null;
  roleName: string | null;
  place: "area" | "other" | "graphic" | null;
  origin: string;
  flags: string[];
}

/** The API lists layers in draw order (bottom first); the panel reads like a colour table, top first. */
export function layersTopFirst<T extends { row: number }>(layers: readonly T[]): T[] {
  return [...layers].sort((a, b) => b.row - a.row);
}

/**
 * What names a row's layer: its IOF role, else its place — a colour split
 * only by place (`roles: [null, null]`, carried from I3) is told apart by
 * it, never by a role.
 */
export function layerLabel(layer: Pick<ColourLayerLike, "role" | "roleName" | "place">): { kind: "role"; name: string } | { kind: "place"; key: `colours.layers.place.${"area" | "other" | "graphic"}` } {
  if (layer.role) return { kind: "role", name: layer.roleName ?? layer.role };
  return { kind: "place", key: `colours.layers.place.${layer.place ?? "other"}` };
}

/** The flags in the order the panel shows them. */
export const FLAG_ORDER = ["split", "deviation-kept", "deviation-dropped", "source-ordered", "no-role", "own-order", "above-lower-purple", "draws-nothing"] as const;
export type ColourFlag = (typeof FLAG_ORDER)[number];

export function orderedFlags(flags: readonly string[]): ColourFlag[] {
  return FLAG_ORDER.filter((f) => flags.includes(f));
}

/** Whether the switch may be used: edit rights, a target (a club review needs its series), no job running. */
export function canSwitchOrder(opts: { canEdit: boolean; busy: boolean; hasTarget: boolean }): boolean {
  return opts.canEdit && opts.hasTarget && !opts.busy;
}

/** The order the switch shows as chosen: the map's setting, else the document's own. */
export function chosenOrder(colour: { order: ColourOrder; setting: { order: ColourOrder } | null }): ColourOrder {
  return colour.setting?.order ?? colour.order;
}

/** A picture URL with a retry counter, for an image that answered 503 while the other order was imported. */
export function retryUrl(url: string, attempt: number): string {
  if (attempt <= 0) return url;
  return `${url}${url.includes("?") ? "&" : "?"}retry=${attempt}`;
}

/** The deviations summary: how many, how many kept. */
export function deviationSummary(deviations: readonly { kept: boolean }[]): { count: number; kept: number } {
  return { count: deviations.length, kept: deviations.filter((d) => d.kept).length };
}
