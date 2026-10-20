/**
 * Colour classification (03 §6.3 step 2, §6.5 fingerprint colour classes).
 *
 * A *colour class* is a hue word plus an ink percentage — the vocabulary
 * the IOF specifications use ("brown 100 %", "black 50 %"). Source
 * colours are classified from their name (English / Swedish IOF words,
 * a percentage) confirmed by CMYK, else from CMYK alone; palette entries
 * from their CMYK. Two classes are *the same* when the hue agrees and the
 * percentages are within tolerance, which is the matcher's hard-fail test.
 *
 * Step 2 of alignment — which palette *entry* a source colour is — adds
 * the name qualifiers ("line", "point", "area", "road", "railway", …) on
 * top of the class; see `paletteEntryFor`.
 */

import type { ColourEntry } from "../render/symbol.js";
import { iof2022Palette, iof2024Palette, type PaletteEdition, type PaletteEntry, paletteFor, type SpecId } from "../symbol-library/palette.js";

export type ColourHue =
  | "black" | "white" | "brown" | "blue" | "green" | "darkgreen" | "yellow" | "olive" | "purple" | "orange" | "red" | "registration";

export interface ColourClass {
  hue: ColourHue;
  /** Ink coverage 0..100 of the hue's full colour; 100 for hues without screens. */
  percent: number;
}

export type Cmyk = readonly [number, number, number, number];

/** Percent difference inside which two screens of one hue count as the same class. */
export const PERCENT_TOLERANCE = 20;

const r100 = (v: number) => Math.min(100, Math.round(v * 100));
const snapFull = (p: number) => (p >= 85 ? 100 : p);

/** Hue and screen from CMYK alone. `null` when no IOF hue fits. */
export function classifyCmyk([c, m, y, k]: Cmyk): ColourClass | null {
  if (c >= 0.9 && m >= 0.9 && y >= 0.9) return { hue: "registration", percent: 100 };
  if (c < 0.08 && m < 0.08 && y < 0.08) {
    if (k < 0.03) return { hue: "white", percent: 100 };
    return { hue: "black", percent: snapFull(r100(k)) };
  }
  if (m < 0.1 && y < 0.1 && c >= 0.1) return { hue: "blue", percent: snapFull(r100(c)) };
  if (m >= 0.3 && y < 0.15 && c >= 0.05 && c <= 0.6 && c < m) return { hue: "purple", percent: snapFull(r100(m / 0.85)) };
  if (c >= 0.25 && c <= 0.6 && m >= 0.15 && m <= 0.4 && y >= 0.7) return { hue: "olive", percent: 100 };
  if (c >= 0.2 && m < 0.12 && y >= 0.2 && y >= c * 0.75) {
    if (k >= 0.2) return { hue: "darkgreen", percent: 100 };
    return { hue: "green", percent: snapFull(r100(y)) };
  }
  if (m >= 0.75 && y >= 0.6 && c < 0.15 && k < 0.15) return { hue: "red", percent: 100 };
  if (c < 0.1 && k < 0.08 && m >= 0.4 && m < 0.75 && y >= 0.85) return { hue: "orange", percent: 100 };
  if (c < 0.1 && k < 0.1 && y >= 0.25 && m < 0.35 && m < y * 0.5) return { hue: "yellow", percent: snapFull(r100(y / 0.79)) };
  if (y >= 0.25 && m >= 0.15 && m <= y && (c >= 0.05 || k >= 0.05 || y < 0.6)) return { hue: "brown", percent: snapFull(r100(y)) };
  return null;
}

/** Whole-word vocabulary (ASCII `\b` does not work after å/ä/ö, so names are tokenised). */
const HUE_WORDS: Record<string, ColourHue> = {
  svart: "black", black: "black", grå: "black", grått: "black", grey: "black", gray: "black",
  vit: "white", vitt: "white", white: "white",
  brun: "brown", brunt: "brown", brown: "brown",
  blå: "blue", blått: "blue", blue: "blue",
  grön: "green", grönt: "green", green: "green",
  mörkgrön: "darkgreen", mörkgrönt: "darkgreen",
  gul: "yellow", gult: "yellow", yellow: "yellow",
  oliv: "olive", olive: "olive",
  violett: "purple", lila: "purple", purple: "purple", purpur: "purple", magenta: "purple",
  orange: "orange",
  röd: "red", rött: "red", red: "red",
  registration: "registration", passmärke: "registration", färgseparationer: "registration",
};

export function nameTokens(name: string): string[] {
  return name.toLowerCase().split(/[^\p{L}\p{N}%]+/u).filter(Boolean);
}

/** Hue named in a colour name; `null` when none or when two hues are combined without a known meaning. */
export function hueFromName(name: string): ColourHue | null {
  const tokens = nameTokens(name);
  const hues = new Set<ColourHue>();
  for (const t of tokens) {
    const h = HUE_WORDS[t];
    if (h) hues.add(h);
  }
  const dark = tokens.includes("mörk") || tokens.includes("dark");
  if (hues.size === 1) {
    const [hue] = hues;
    return hue === "green" && dark ? "darkgreen" : hue;
  }
  if (hues.size === 2) {
    if (hues.has("yellow") && hues.has("green")) return "olive";
    if (hues.has("green") && hues.has("black")) return "darkgreen";
  }
  return null;
}

/** The single percentage in a name (`"Brun 50%"` → 50); `null` when none or several. */
export function percentFromName(name: string): number | null {
  const m = [...name.matchAll(/(\d{1,3})\s*%/g)];
  if (m.length !== 1) return null;
  const p = Number(m[0][1]);
  return p >= 0 && p <= 100 ? p : null;
}

export interface ClassifiedColour {
  class: ColourClass | null;
  /** The name said one hue, the ink said another; the ink won. */
  nameMismatch?: boolean;
}

/**
 * Classify a colour from its name and CMYK: the name's hue when the CMYK
 * confirms it (percent from the name if given), otherwise the CMYK class.
 */
/** Mixed inks and solids have no screen: "Gul + Grön 50%" is still olive 100 %. */
const FULL_ONLY = new Set<ColourHue>(["olive", "darkgreen", "registration", "white", "red", "orange"]);

export function classifyColour(entry: Pick<ColourEntry, "name" | "cmyk">): ClassifiedColour {
  const fromInk = classifyCmyk(entry.cmyk);
  const hue = hueFromName(entry.name);
  const pct = hue && FULL_ONLY.has(hue) ? null : percentFromName(entry.name);
  if (hue && fromInk && fromInk.hue === hue) return { class: { hue, percent: pct !== null ? snapFull(pct) : fromInk.percent } };
  if (hue && !fromInk) return { class: { hue, percent: pct !== null ? snapFull(pct) : 100 } };
  if (hue && fromInk && fromInk.hue !== hue) {
    // Grey named, black ink — the same family; otherwise the ink decides.
    return { class: fromInk, nameMismatch: true };
  }
  return { class: fromInk };
}

export function sameClass(a: ColourClass | null | undefined, b: ColourClass | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.hue !== b.hue) return false;
  if (a.hue === "white" || a.hue === "registration") return true;
  return Math.abs(a.percent - b.percent) <= PERCENT_TOLERANCE;
}

export function formatClass(c: ColourClass | null | undefined): string {
  if (!c) return "unclassified";
  return c.percent === 100 || c.hue === "white" ? c.hue : `${c.hue} ${c.percent} %`;
}

const paletteClassCache = new Map<string, ColourClass | null>();

/** Colour class of a palette entry (by edition, since screens moved between editions). */
export function paletteClass(id: string, edition: PaletteEdition = "iof2024"): ColourClass | null {
  const key = `${edition}:${id}`;
  let c = paletteClassCache.get(key);
  if (c === undefined) {
    const entry = (edition === "iof2024" ? iof2024Palette : iof2022Palette).find((e) => e.id === id);
    c = entry ? classifyCmyk(entry.cmyk) : null;
    paletteClassCache.set(key, c);
  }
  return c;
}

/**
 * Name qualifiers that pick one palette entry among those of the same
 * class. Each rule adds its weight when the regex matches the name; the
 * highest total wins, ties go to `DEFAULT_ORDER`.
 */
const QUALIFIERS: { id: RegExp; name: RegExp; weight: number }[] = [
  { id: /-line$|pointline$/, name: /linje|line|kontur|nordlinje|north|meridian/, weight: 2 },
  { id: /-point$|pointline$/, name: /punkt|point/, weight: 2 },
  { id: /-area$/, name: /\byta|ytobjekt|area|fyll/, weight: 2 },
  { id: /-road$/, name: /väg|road|street|gata/, weight: 2 },
  { id: /-paved$/, name: /belagd|paved|asfalt|hård/, weight: 2 },
  { id: /^white-railway$/, name: /järnväg|railway|railroad|\brail\b/, weight: 3 },
  { id: /^white-two-level$/, name: /nivå|level/, weight: 3 },
  { id: /^white-over-yellow$/, name: /\bgul|yellow/, weight: 2 },
  { id: /^white-over-green-brown$/, name: /grön|green|brun|brown|skog|forest/, weight: 2 },
  { id: /^white-upper$/, name: /övre|upper|banpåtryck|course|overprint|bana/, weight: 2 },
  { id: /^black-road-outline$/, name: /väg|road|sidlinje|outline|kant|street/, weight: 2 },
  { id: /^black-cultivated$/, name: /odlad|cultivated|sand|åker|field/, weight: 3 },
  { id: /^black50-building$/, name: /byggnad|building|hus/, weight: 2 },
  { id: /^black60-building$/, name: /byggnad|building|hus/, weight: 2 },
  { id: /^black20-canopy$/, name: /\btak|canopy|skärmtak|passage/, weight: 2 },
  { id: /^black-area-screen$/, name: /\byta|area|berg|rock|häll|raster/, weight: 1 },
  { id: /^darkgreen-hedge$/, name: /häck|hedge/, weight: 2 },
  { id: /^darkgreen-line$/, name: /linje|line/, weight: 2 },
  { id: /^darkgreen-area$/, name: /\byta|area|vegetation|opasserbar|impassable/, weight: 2 },
  { id: /^purple-lower$/, name: /undre|lower|nedre|under/, weight: 3 },
  { id: /^purple-upper$/, name: /övre|upper|överst|top|over\b/, weight: 3 },
];

/** Preference order when qualifiers do not decide. */
const DEFAULT_ORDER = [
  "black100", "black-road-outline", "black-cultivated",
  "brown100-line", "brown100", "brown100-point",
  "blue100-line", "blue100-pointline", "blue100-area", "blue100-point",
  "green100-area", "green100-point",
  "white-over-green-brown", "white-over-yellow", "white-railway", "white-two-level", "white-upper",
  "darkgreen-hedge", "darkgreen-line", "darkgreen-area",
  "brown50-road", "brown50-paved", "brown30-road", "brown30-paved",
  "black50-building", "black60-building", "black20-canopy", "black-area-screen",
  "blue70-area", "blue50-area", "blue30-area",
  "green60-area", "green30-area", "yellow100", "yellow75", "yellow50", "olive",
  "purple-lower", "purple-upper", "purple50",
];
const defaultRank = (id: string) => {
  const i = DEFAULT_ORDER.indexOf(id);
  return i < 0 ? DEFAULT_ORDER.length : i;
};

export interface PaletteEntryChoice {
  entry: PaletteEntry;
  /** Qualifier weight that selected it (0 = chosen by default order). */
  score: number;
}

/**
 * Which palette entry of `spec` a source colour *is*: same class, then
 * name qualifiers, then default order. `null` when no entry has the class.
 * Purple is handled by the caller (position decides lower vs upper when
 * the name does not).
 */
export function paletteEntryFor(entry: Pick<ColourEntry, "name" | "cmyk">, cls: ColourClass | null, spec: SpecId, edition: PaletteEdition): PaletteEntryChoice | null {
  if (!cls) return null;
  const n = entry.name.toLowerCase();
  const candidates = paletteFor(edition, spec).filter((p) => sameClass(paletteClass(p.id, edition), cls));
  if (candidates.length === 0) return null;
  // Qualifiers first, then the nearest screen (brown 30 % is "brown50-road"
  // by class tolerance but "brown30-road" by value), then the default order.
  const scored = candidates.map((p) => ({
    entry: p,
    score: QUALIFIERS.reduce((s, q) => (q.id.test(p.id) && q.name.test(n) ? s + q.weight : s), 0),
    off: Math.abs((paletteClass(p.id, edition)?.percent ?? 100) - cls.percent),
  }));
  scored.sort((a, b) => b.score - a.score || a.off - b.off || defaultRank(a.entry.id) - defaultRank(b.entry.id));
  return { entry: scored[0].entry, score: scored[0].score };
}

/** Euclidean CMYK distance. */
export function cmykDistance(a: Cmyk, b: Cmyk): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]);
}

/**
 * Which palette edition the source colours were drawn with: the one whose
 * values the classified brown / green / black-screen colours sit nearer.
 * Ties and no evidence → `iof2024`.
 */
export function detectPaletteEdition(colours: readonly Pick<ColourEntry, "name" | "cmyk">[]): PaletteEdition {
  const differing = ["brown100-line", "brown50-road", "green100-area", "green60-area", "green30-area", "black-area-screen"];
  let v2022 = 0, v2024 = 0;
  for (const c of colours) {
    const cls = classifyColour(c).class;
    if (!cls || !["brown", "green", "black"].includes(cls.hue)) continue;
    for (const id of differing) {
      const a = iof2024Palette.find((e) => e.id === id)!;
      const b = iof2022Palette.find((e) => e.id === id)!;
      if (!sameClass(classifyCmyk(a.cmyk), cls)) continue;
      const da = cmykDistance(c.cmyk, a.cmyk), db = cmykDistance(c.cmyk, b.cmyk);
      if (da < db - 0.02) v2024++;
      else if (db < da - 0.02) v2022++;
    }
  }
  return v2022 > v2024 ? "iof2022" : "iof2024";
}
