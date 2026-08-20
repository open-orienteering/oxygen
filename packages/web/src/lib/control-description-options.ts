/**
 * Pickable options for the control description editor.
 *
 * Descriptions are stored on the control row in the OCAD course-setting
 * text encoding (see `ControlDescription` in @oxygen/shared), while the
 * SVG symbols in `iof-symbols.ts` are keyed by IOF number. This module
 * enumerates every symbol the editor offers per sheet column and pairs
 * it with a canonical OCAD code — chosen so the existing OCAD→IOF
 * converters in `iof-symbols.ts` map it straight back to the same
 * symbol (round-trip verified by unit tests).
 */

import { ocadCtoIof, ocadDtoIof, ocadFtoIof, ocadGtoIof } from "../iof-symbols";
import { IOF_SYMBOL_META } from "../iof-symbol-meta";

export interface DescriptionOption {
  /** IOF symbol key into IOF_SYMBOLS / IOF_SYMBOL_META (e.g. "2.4"). */
  iof: string;
  /** Canonical OCAD code stored in controls.description (e.g. "2.004"). */
  ocad: string;
}

/** Compass directions in IOF sheet order; index+1 = OCAD direction digit. */
export const COMPASS_DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

const dirIndex = (dir: string): number => COMPASS_DIRECTIONS.indexOf(dir as never) + 1;

// ─── Column C: which of similar features ─────────────────────────────

const C_CARDINAL = new Set(["N", "E", "S", "W"]);

/** 8 compass directions ("N side of…") followed by upper/lower/middle. */
export const C_OPTIONS: DescriptionOption[] = [
  ...COMPASS_DIRECTIONS.map((dir) => ({
    iof: `${C_CARDINAL.has(dir) ? "0.1" : "0.2"}${dir}`,
    ocad: `0.${200 + dirIndex(dir)}`,
  })),
  { iof: "0.3", ocad: "0.300" },
  { iof: "0.4", ocad: "0.400" },
  { iof: "0.5", ocad: "0.500" },
];

// ─── Column D: control feature ───────────────────────────────────────

/**
 * All column-D symbols, grouped by IOF family:
 * 1 landforms, 2 rock & boulders, 3 water & marsh, 4 vegetation,
 * 5 man-made, 6 special items.
 */
export const D_GROUPS: { group: number; options: DescriptionOption[] }[] = (() => {
  const byGroup = new Map<number, DescriptionOption[]>();
  const keys = Object.keys(IOF_SYMBOL_META)
    .filter((k) => IOF_SYMBOL_META[k].kind === "D")
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  for (const iof of keys) {
    const [grp, sub] = iof.split(".");
    const options = byGroup.get(Number(grp));
    const option = { iof, ocad: `${grp}.${sub.padStart(3, "0")}` };
    if (options) options.push(option);
    else byGroup.set(Number(grp), [option]);
  }
  return [...byGroup.entries()]
    .sort(([a], [b]) => a - b)
    .map(([group, options]) => ({ group, options }));
})();

// ─── Column F: combination ───────────────────────────────────────────

/** Crossing, junction, bend — matches OCAD_F_MAP in iof-symbols.ts. */
export const F_OPTIONS: DescriptionOption[] = [
  { iof: "10.1", ocad: "10.001" },
  { iof: "10.2", ocad: "10.002" },
  { iof: "11.7", ocad: "11.001" },
];

// ─── Column G: location of the control flag ──────────────────────────

// IOF base → OCAD sub builder. Types 1-6 use the type×100 encoding,
// "end" (11.8) is OCAD type 7, directional "foot" (11.14) uses the
// 120-range encoding.
const G_DIRECTIONAL_BASES: { iofBase: string; ocadSub: (idx: number) => number }[] = [
  { iofBase: "11.1", ocadSub: (i) => 100 + i },
  { iofBase: "11.2", ocadSub: (i) => 200 + i },
  { iofBase: "11.3", ocadSub: (i) => 300 + i },
  { iofBase: "11.4", ocadSub: (i) => 400 + i },
  { iofBase: "11.5", ocadSub: (i) => 500 + i },
  { iofBase: "11.6", ocadSub: (i) => 600 + i },
  { iofBase: "11.8", ocadSub: (i) => 700 + i },
  { iofBase: "11.14", ocadSub: (i) => 120 + i },
];

/** Directional flag locations: one row per feature part, 8 directions each. */
export const G_DIRECTIONAL: { iofBase: string; byDirection: DescriptionOption[] }[] =
  G_DIRECTIONAL_BASES.map(({ iofBase, ocadSub }) => ({
    iofBase,
    byDirection: COMPASS_DIRECTIONS.map((dir) => ({
      iof: `${iofBase}${dir}`,
      ocad: `11.${ocadSub(dirIndex(dir))}`,
    })),
  }));

/** Non-directional flag locations (upper part, top, beneath, between…). */
export const G_PLAIN: DescriptionOption[] = [
  { iof: "11.9", ocad: "11.008" },
  { iof: "11.10", ocad: "11.009" },
  { iof: "11.11", ocad: "11.010" },
  { iof: "11.12", ocad: "11.013" },
  { iof: "11.13", ocad: "11.011" },
  { iof: "11.15", ocad: "11.014" },
];

export const G_OPTIONS: DescriptionOption[] = [
  ...G_DIRECTIONAL.flatMap((g) => g.byDirection),
  ...G_PLAIN,
];

/** All options for one ControlDescription field. */
export const OPTIONS_BY_FIELD = {
  c: C_OPTIONS,
  d: D_GROUPS.flatMap((g) => g.options),
  f: F_OPTIONS,
  g: G_OPTIONS,
} as const;

/**
 * Which IOF symbol does a stored OCAD code render as? Delegates to the
 * same converters the description sheet uses, so codes imported from
 * OCD files resolve correctly even when they use a different OCAD
 * encoding than the editor's canonical one (several OCAD sub-codes can
 * mean the same symbol).
 */
export function ocadToIof(field: "c" | "d" | "f" | "g", ocad: string): string | null {
  switch (field) {
    case "c": return ocadCtoIof(ocad);
    case "d": return ocadDtoIof(ocad);
    case "f": return ocadFtoIof(ocad);
    case "g": return ocadGtoIof(ocad);
  }
}
