/**
 * The colour panel's payload (docs/map-symbols.md §8.7 "Colour layers",
 * §9.3 "Per map (row I6)"): `mapImport.review` → `colour`. Pure over a
 * stored document's header and import report: the layered stack's rows in
 * draw order with their colour, role and flags, every deviation kept or
 * dropped with its default, and the URLs of the before / after picture.
 */

import { mapDocument, mapImport, render, symbolLibrary } from "@oxygen/shared";
import { colourSettingsOfReport, defaultDeviationChoice, pictureDeviationsQuery, reportColourFallback, reportColourOrder, type ColourOrder, type MapColourSettings } from "./colour-settings.js";

export type ColourLayerFlag =
  /** The row's source colour stands on several rows that draw (a draws-nothing `identified` row does not count). */
  | "split"
  /** Placed by the map's own order (`sourceOrdered`: no role, a graphic object's colour, a mask). */
  | "source-ordered"
  /** Uses with no IOF role. */
  | "no-role"
  /** A part of a symbol moved under another part of it (§9.3 "Own order"). */
  | "own-order"
  /** A source-ordered row above lower purple (it may hide the course). */
  | "above-lower-purple"
  /** The row's role is in a kept deviation (drawn in the map's order against the palette's). */
  | "deviation-kept"
  /** The row's role is in a dropped deviation (drawn in the palette's order against the map's). */
  | "deviation-dropped"
  /** Symbols reference the row but no object is drawn in it: a library-drawn symbol's own reference. */
  | "draws-nothing";

export interface ColourLayerView {
  /** Index in the stack = draw order, 0 drawn first. */
  row: number;
  /** The stack row's id (`src:<n>`, `src:<n>/<role>`, `<edition>:<role>`). */
  id: string;
  /** The map's own colour name (an inserted row: the palette's). */
  name: string;
  /** Screen colour of the row's CMYK (`render.cmykToHex`). */
  hex: string;
  sourceNumber: number | null;
  /** IOF palette id, or `null` (no role: see `place`). */
  role: string | null;
  /** The palette row's English name; `null` without a role. */
  roleName: string | null;
  /** A row without a role: `area`, `other`, or `graphic` for a graphic object's colour. */
  place: "area" | "other" | "graphic" | null;
  origin: mapImport.LayerOrigin;
  objects: number;
  symbols: number;
  sourceOrdered: mapImport.SourceOrderReason | null;
  flags: ColourLayerFlag[];
}

export interface ColourDeviationView {
  /** `upper>lower`, the override key (row I7). */
  key: string;
  upper: string;
  lower: string;
  upperName: string;
  lowerName: string;
  kept: boolean;
  /** What the deviation is without an override (the user's answer 2). */
  default: mapImport.DeviationChoice;
  /** Why it is kept or dropped: its default, an override, implied by kept ones, or blocked (wanted kept, cannot hold). */
  why: "default" | "override" | "implied" | "blocked";
  objects: { upper: number; lower: number };
  /** What the map the review is for asks for this deviation: its override, else the default; `null` without a target (row I7). */
  choice: mapImport.DeviationChoice | null;
  /** The map overrides this deviation (its setting holds the key), read from the setting, not the report: an override that changes no bytes is not in the report (row I7). */
  overridden: boolean;
  impliedBy?: string[];
  blockedBy?: string[];
}

export interface ColourReview {
  /** The order this document is drawn in. */
  order: ColourOrder;
  /** The document was asked for the IOF order and fell back to the map's own (`COLOUR_LAYERS_FAILED`). */
  fallback: boolean;
  /** The setting this document was built with (its order and overrides, from the report). */
  built: MapColourSettings;
  /** The setting of the map the review is for (`null` without a target): what the switch shows as chosen. */
  setting: MapColourSettings | null;
  /** The layered stack's rows in draw order; `null` in the map's own order, which has no roles. */
  layers: ColourLayerView[] | null;
  /** Every deviation, kept or dropped, the most objects first; `[]` in the map's own order. */
  deviations: ColourDeviationView[];
  /**
   * The before / after picture in each order (`/api/map-documents/:hash/colour-order/:order.png`); a `source`
   * document's IOF picture carries the map's overrides as `?deviations=` (row I7).
   */
  pictures: Record<ColourOrder, string>;
}

export function colourPictureUrl(hash: string, order: ColourOrder, deviations: Readonly<Record<string, mapImport.DeviationChoice>> = {}): string {
  const q = order === "iof" ? pictureDeviationsQuery(deviations) : "";
  return `/api/map-documents/${hash}/colour-order/${order}.png${q ? `?deviations=${encodeURIComponent(q)}` : ""}`;
}

const ROLE_NAMES: ReadonlyMap<string, string> = new Map(
  [...symbolLibrary.palettes.iof2022, ...symbolLibrary.palettes.iof2024].map((p) => [p.id, p.name] as const),
);

/** A palette id's English name; the id itself when unknown. */
export const roleName = (id: string): string => ROLE_NAMES.get(id) ?? id;

type Layers = NonNullable<mapImport.ColourStackSummary["layers"]>;

export function buildColourReview(hash: string, header: Pick<mapDocument.MapDocumentHeader, "colours">, report: unknown, setting: MapColourSettings | null): ColourReview {
  const layers = (report as { colourStack?: { layers?: Layers } } | null)?.colourStack?.layers;
  const order = reportColourOrder(report) ?? (layers ? "iof" : "source");
  // A `source` document's IOF picture is the document the switch gives: drawn with the map's overrides (row I7).
  const pictures = { iof: colourPictureUrl(hash, "iof", order === "source" && setting ? setting.deviations : {}), source: colourPictureUrl(hash, "source") };
  const base = { order, fallback: reportColourFallback(report), built: colourSettingsOfReport(report), setting, pictures };
  if (order !== "iof" || !layers) return { ...base, layers: null, deviations: [] };

  // A colour is split when it draws on several rows: a zero-object palette-id row (`identified`, I5) is not one.
  const drawingRows = new Map<number, number>();
  for (const r of layers.rows) if (r.source !== null && r.origin !== "identified") drawingRows.set(r.source, (drawingRows.get(r.source) ?? 0) + 1);
  const above = new Set(layers.sourceOrdered.filter((s) => s.aboveLowerPurple).map((s) => s.row));
  const keptRoles = new Set<string>(), droppedRoles = new Set<string>();
  for (const d of layers.deviations) for (const role of [d.upper, d.lower]) (d.kept ? keptRoles : droppedRoles).add(role);

  const rows: ColourLayerView[] = layers.rows.map((r) => {
    const c = header.colours[r.row];
    const flags: ColourLayerFlag[] = [];
    if (r.source !== null && (drawingRows.get(r.source) ?? 0) > 1 && r.origin !== "identified") flags.push("split");
    if (r.sourceOrdered) flags.push("source-ordered");
    if (r.role === null && r.sourceOrdered !== "graphic") flags.push("no-role");
    if (r.ownOrder) flags.push("own-order");
    if (above.has(r.row)) flags.push("above-lower-purple");
    if (r.role && r.objects > 0 && keptRoles.has(r.role)) flags.push("deviation-kept");
    if (r.role && r.objects > 0 && droppedRoles.has(r.role)) flags.push("deviation-dropped");
    if (r.objects === 0 && r.symbols > 0) flags.push("draws-nothing");
    return {
      row: r.row,
      id: c?.id ?? `row:${r.row}`,
      name: c?.name ?? "",
      hex: c ? render.cmykToHex(c.cmyk) : "#ff00ff",
      sourceNumber: c?.sourceNumber ?? null,
      role: r.role,
      roleName: r.role ? roleName(r.role) : null,
      place: r.role ? null : r.sourceOrdered === "graphic" ? "graphic" : (r.place ?? "other"),
      origin: r.origin,
      objects: r.objects,
      symbols: r.symbols,
      sourceOrdered: r.sourceOrdered,
      flags,
    };
  });

  const deviations: ColourDeviationView[] = layers.deviations.map((d) => {
    const key = mapImport.deviationKey(d.upper, d.lower);
    const why: ColourDeviationView["why"] = d.blockedBy ? "blocked" : d.impliedBy ? "implied" : d.byDefault ? "default" : "override";
    return {
      key,
      upper: d.upper,
      lower: d.lower,
      upperName: roleName(d.upper),
      lowerName: roleName(d.lower),
      kept: d.kept,
      default: defaultDeviationChoice(key),
      why,
      choice: setting ? (setting.deviations[key] ?? defaultDeviationChoice(key)) : null,
      overridden: !!setting && key in setting.deviations,
      objects: d.objects,
      ...(d.impliedBy ? { impliedBy: d.impliedBy } : {}),
      ...(d.blockedBy ? { blockedBy: d.blockedBy } : {}),
    };
  });
  return { ...base, layers: rows, deviations };
}
