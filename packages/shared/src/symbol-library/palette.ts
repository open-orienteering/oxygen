/**
 * The canonical IOF colour palette (03 §6.3, Appendix B): the colour-order
 * table of *Printing and Colour Definitions for Orienteering Maps* as data,
 * one palette per edition. Library entries reference palette ids, never
 * CMYK values; the edition decides the values. Normative: docs/map-symbols.md §3.
 *
 * Rows are authored in the IOF table's order — top first, i.e. the first
 * row is drawn *last*. `paletteStack()` reverses that into a `ColourStack`
 * (index 0 drawn first) for one specification.
 */

import type { ColourEntry, ColourStack } from "../render/symbol.js";

export type SpecId = "ISOM2017-2" | "ISSprOM2019-2" | "ISSkiOM2019" | "ISMTBOM2022";
export type PaletteEdition = "iof2022" | "iof2024";

export interface PaletteEntry {
  /** Stable across editions; what library entries reference. */
  id: string;
  /** Name as printed in the colour table of this edition. */
  name: string;
  /** CMYK 0..1. */
  cmyk: readonly [number, number, number, number];
  /** Specifications whose colour table lists this row. */
  specs: readonly SpecId[];
  purpleRole?: "lower" | "upper";
}

const pct = (c: number, m: number, y: number, k: number): readonly [number, number, number, number] =>
  [c / 100, m / 100, y / 100, k / 100] as const;

const ISOM = "ISOM2017-2";
const SPR = "ISSprOM2019-2";
const SKI = "ISSkiOM2019";
const MTB = "ISMTBOM2022";

/** Printing and Colour Definitions Rev 4 (September 2024), 43 rows, top first. */
export const iof2024Palette: readonly PaletteEntry[] = [
  { id: "purple-upper", name: "Upper purple for course overprint", cmyk: pct(35, 85, 0, 0), specs: [ISOM, SPR, SKI, MTB], purpleRole: "upper" },
  { id: "white-upper", name: "Upper white for course overprint", cmyk: pct(0, 0, 0, 0), specs: [SPR, SKI, MTB] },
  { id: "purple50", name: "Purple 50 % area symbol", cmyk: pct(18, 43, 0, 0), specs: [SPR, MTB], purpleRole: "upper" },
  { id: "green-skio", name: "Green for Ski-O", cmyk: pct(91, 0, 83, 0), specs: [SKI] },
  { id: "orange-skio", name: "Orange for Ski-O", cmyk: pct(0, 60, 100, 0), specs: [SKI] },
  { id: "white-railway", name: "White for railroad", cmyk: pct(0, 0, 0, 0), specs: [ISOM, SPR, MTB] },
  { id: "black100", name: "Black 100 %", cmyk: pct(0, 0, 0, 100), specs: [ISOM, SPR, SKI, MTB] },
  { id: "blue100-point", name: "Blue 100 % point symbols", cmyk: pct(100, 0, 0, 0), specs: [ISOM] },
  { id: "brown100-point", name: "Brown 100 % point symbols", cmyk: pct(25, 75, 100, 0), specs: [ISOM] },
  { id: "green100-point", name: "Green 100 % point symbols", cmyk: pct(80, 0, 100, 0), specs: [ISOM, SPR, MTB] },
  { id: "blue100-line", name: "Blue 100 % line symbols", cmyk: pct(100, 0, 0, 0), specs: [ISOM, SKI, MTB] },
  { id: "darkgreen-hedge", name: "Dark green for hedges in forest", cmyk: pct(100, 0, 80, 30), specs: [ISOM] },
  { id: "brown100-line", name: "Brown 100 % line symbols", cmyk: pct(25, 75, 100, 0), specs: [ISOM] },
  { id: "purple-lower", name: "Lower purple for course overprint", cmyk: pct(35, 85, 0, 0), specs: [ISOM, SPR, SKI, MTB], purpleRole: "lower" },
  { id: "darkgreen-line", name: "Dark green line symbols", cmyk: pct(100, 0, 80, 30), specs: [SPR] },
  { id: "blue100-pointline", name: "Blue 100 % point and line symbols", cmyk: pct(100, 0, 0, 0), specs: [SPR, MTB] },
  { id: "brown100", name: "Brown 100 %", cmyk: pct(25, 75, 100, 0), specs: [SPR, SKI, MTB] },
  { id: "white-two-level", name: "White stripes for area passable at two levels", cmyk: pct(0, 0, 0, 0), specs: [SPR] },
  { id: "brown50-road", name: "Brown 50 % for road infill", cmyk: pct(10, 35, 50, 0), specs: [ISOM, SPR, SKI, MTB] },
  { id: "brown30-road", name: "Brown 30 % for road infill", cmyk: pct(6, 23, 33, 0), specs: [SPR] },
  { id: "black-road-outline", name: "Black 100 % for road outline", cmyk: pct(0, 0, 0, 100), specs: [ISOM, SPR, SKI, MTB] },
  { id: "black60-building", name: "Black 60 % for buildings", cmyk: pct(0, 0, 0, 60), specs: [MTB] },
  { id: "black50-building", name: "Black 50 % for large buildings", cmyk: pct(0, 0, 0, 50), specs: [ISOM, SPR] },
  { id: "black20-canopy", name: "Black 20 % for canopy", cmyk: pct(0, 0, 0, 20), specs: [ISOM, SPR, MTB] },
  { id: "blue100-area", name: "Blue 100 % area symbols", cmyk: pct(100, 0, 0, 0), specs: [ISOM, SPR, SKI, MTB] },
  { id: "blue70-area", name: "Blue 70 % area symbols", cmyk: pct(70, 0, 0, 0), specs: [ISOM, SPR, MTB] },
  { id: "blue50-area", name: "Blue 50 % area symbols", cmyk: pct(50, 0, 0, 0), specs: [ISOM, SPR, SKI] },
  { id: "blue30-area", name: "Blue 30 % area symbols", cmyk: pct(30, 0, 0, 0), specs: [SPR] },
  { id: "white-over-green-brown", name: "White over green and brown", cmyk: pct(0, 0, 0, 0), specs: [ISOM, SPR] },
  { id: "brown50-paved", name: "Brown 50 % for paved area", cmyk: pct(10, 35, 50, 0), specs: [ISOM, SPR, SKI, MTB] },
  { id: "brown30-paved", name: "Brown 30 % for paved area", cmyk: pct(6, 23, 33, 0), specs: [SPR] },
  { id: "olive", name: "Olive green", cmyk: pct(38, 27, 100, 0), specs: [ISOM, SPR, SKI, MTB] },
  { id: "darkgreen-area", name: "Dark green area symbols", cmyk: pct(100, 0, 80, 30), specs: [SPR] },
  { id: "green100-area", name: "Green 100 % area symbols", cmyk: pct(80, 0, 100, 0), specs: [ISOM, SPR] },
  { id: "green60-area", name: "Green 60 % area symbols", cmyk: pct(48, 0, 60, 0), specs: [ISOM, SPR] },
  { id: "green30-area", name: "Green 30 % area symbols", cmyk: pct(24, 0, 30, 0), specs: [ISOM, SPR, SKI, MTB] },
  { id: "black-area-screen", name: "Black 35 % area symbols", cmyk: pct(0, 0, 0, 35), specs: [ISOM, SPR] },
  { id: "white-over-yellow", name: "White over yellow", cmyk: pct(0, 0, 0, 0), specs: [ISOM, SPR, SKI, MTB] },
  { id: "black-cultivated", name: "Black for cultivated land and sandy ground", cmyk: pct(0, 0, 0, 100), specs: [ISOM, SPR, MTB] },
  { id: "orange-mtbo", name: "Orange for MTBO", cmyk: pct(0, 60, 100, 0), specs: [MTB] },
  { id: "yellow100", name: "Yellow 100 % area symbols", cmyk: pct(0, 27, 79, 0), specs: [ISOM, SPR, MTB] },
  { id: "yellow75", name: "Yellow 75 % area symbols", cmyk: pct(0, 20, 59, 0), specs: [ISOM, SKI] },
  { id: "yellow50", name: "Yellow 50 % area symbols", cmyk: pct(0, 14, 40, 0), specs: [ISOM, SPR, SKI, MTB] },
];

/**
 * The 2022 edition: same order and ids, the pre-2024 CMYK values (03 §2.3),
 * no Ski-O orange, black area screen at 30 %, olive named by its mix.
 */
const iof2022Overrides: Record<string, Partial<PaletteEntry>> = {
  "brown100-point": { cmyk: pct(0, 56, 100, 18) },
  "brown100-line": { cmyk: pct(0, 56, 100, 18) },
  brown100: { cmyk: pct(0, 56, 100, 18) },
  "brown50-road": { cmyk: pct(0, 28, 50, 9) },
  "brown50-paved": { cmyk: pct(0, 28, 50, 9) },
  "brown30-road": { cmyk: pct(0, 17, 30, 5) },
  "brown30-paved": { cmyk: pct(0, 17, 30, 5) },
  "green100-point": { cmyk: pct(76, 0, 91, 0) },
  "green100-area": { cmyk: pct(76, 0, 91, 0) },
  "green60-area": { cmyk: pct(46, 0, 55, 0) },
  "green30-area": { cmyk: pct(24, 0, 27, 0) },
  "black-area-screen": { name: "Black 30 % area symbols", cmyk: pct(0, 0, 0, 30) },
  olive: { name: "Yellow 100 % + Green 50 %" },
};

export const iof2022Palette: readonly PaletteEntry[] = iof2024Palette
  .filter((e) => e.id !== "orange-skio")
  .map((e) => ({ ...e, ...iof2022Overrides[e.id] }));

export const palettes: Record<PaletteEdition, readonly PaletteEntry[]> = {
  iof2022: iof2022Palette,
  iof2024: iof2024Palette,
};

/** Rows of one edition that apply to `spec`, still top first. */
export function paletteFor(edition: PaletteEdition, spec: SpecId): PaletteEntry[] {
  return palettes[edition].filter((e) => e.specs.includes(spec));
}

/**
 * A document colour stack (index 0 drawn first) for one specification and
 * edition. Ids are prefixed `<edition>:` as 03 §6.3 prescribes.
 */
export function paletteStack(edition: PaletteEdition, spec: SpecId): ColourStack {
  return paletteFor(edition, spec)
    .slice()
    .reverse()
    .map((e): ColourEntry => ({
      id: `${edition}:${e.id}`,
      name: e.name,
      cmyk: [...e.cmyk],
      ...(e.purpleRole ? { purpleRole: e.purpleRole } : {}),
    }));
}

/** Palette id → stack index for `paletteStack(edition, spec)`. */
export function paletteIndex(edition: PaletteEdition, spec: SpecId): Map<string, number> {
  const rows = paletteFor(edition, spec).slice().reverse();
  return new Map(rows.map((e, i) => [e.id, i]));
}
