/**
 * The route search's cost model (docs/course-elevation.md §7.6): what a
 * map symbol is to a runner (a cost class), and how fast a class is run
 * at a slope. `DEFAULT_COST_MODEL` is an uncalibrated first guess; a
 * model calibrated from GPS tracks replaces it behind `CostModel`.
 *
 * Costs are in **flat-forest metres**: one metre of flat, runnable
 * forest (405) costs 1; a route's cost times a pace is its time.
 */

/** Cost classes; the grid stores the index. `forest` is 0: what an unmapped cell is. */
export const COST_CLASSES = [
  "forest", "paved", "road", "path", "smallPath", "open", "roughOpen", "slow", "walk", "fight",
  "marsh", "water", "boulders", "denseBoulders",
  /** Uncrossable water and marsh (301, 307): a path drawn over it is a bridge. */
  "blockedSoft",
  /** Everything else uncrossable or out of bounds: nothing opens it. */
  "blocked",
] as const;
export type CostClass = (typeof COST_CLASSES)[number];
export const CLASS_INDEX = Object.fromEntries(COST_CLASSES.map((c, i) => [c, i])) as Record<CostClass, number>;
export const BLOCKED_SOFT = CLASS_INDEX.blockedSoft;
export const BLOCKED = CLASS_INDEX.blocked;
export const isBlockedClass = (cls: number): boolean => cls >= BLOCKED_SOFT;

/** Line objects of these classes are ways to run along; other passable classes mean nothing as a line. */
export const WAY_CLASSES: ReadonlySet<number> = new Set([CLASS_INDEX.paved, CLASS_INDEX.road, CLASS_INDEX.path, CLASS_INDEX.smallPath]);

/**
 * Which area wins a cell (the colour stack's order, roughly): white
 * below yellow below green below the browns and blues, the uncrossable
 * on top.
 */
export const CLASS_PRIORITY: readonly number[] = COST_CLASSES.map((c) => ({
  forest: 0, open: 1, roughOpen: 1, slow: 2, walk: 2, fight: 2, boulders: 3, denseBoulders: 3, marsh: 3, water: 3,
  paved: 4, road: 4, path: 4, smallPath: 4, blockedSoft: 5, blocked: 6,
} as Record<CostClass, number>)[c]);

/** ISOM 2017-2 / ISSprOM 2019-2 symbol number (the code's integer part) → cost class. */
const CODE_CLASS: Readonly<Record<number, CostClass>> = {
  201: "blocked", 208: "boulders", 209: "denseBoulders", 210: "slow", 211: "walk", 212: "fight", 213: "roughOpen", 214: "open",
  301: "blockedSoft", 302: "water", 307: "blockedSoft", 308: "marsh", 310: "marsh",
  401: "open", 402: "open", 403: "roughOpen", 404: "roughOpen", 405: "forest", 406: "slow", 407: "slow", 408: "walk", 409: "walk", 410: "fight",
  411: "blocked", 412: "open", 413: "open", 414: "slow",
  501: "paved", 502: "road", 503: "road", 504: "path", 505: "path", 506: "smallPath", 507: "smallPath", 508: "smallPath",
  515: "blocked", 518: "blocked", 520: "blocked", 521: "blocked", 529: "blocked",
  708: "blocked", 709: "blocked",
};

/** The cost class of a symbol code (`"405"`, `"501.1"`), or null when the symbol says nothing about running. */
export function costClassOfCode(code: string): number | null {
  const cls = CODE_CLASS[parseInt(code, 10)];
  return cls === undefined ? null : CLASS_INDEX[cls];
}

export interface CostModel {
  id: string;
  /** False until the factors come from measured tracks. */
  calibrated: boolean;
  /** Time per metre relative to flat forest, by class index; blocked classes are never read. */
  classFactor: readonly number[];
  /** Time per horizontal metre relative to flat, at `grade` = rise / run in the running direction. */
  slopeFactor(grade: number): number;
}

const FACTORS: Record<CostClass, number> = {
  forest: 1, paved: 0.62, road: 0.65, path: 0.72, smallPath: 0.85, open: 0.8, roughOpen: 0.92, slow: 1.3, walk: 1.8, fight: 3.2,
  marsh: 1.5, water: 2.2, boulders: 1.7, denseBoulders: 2.6, blockedSoft: Infinity, blocked: Infinity,
};

/**
 * Up: 100 m of climb costs about 750 m of flat. Down: faster to −10 %,
 * then slower again as it steepens.
 */
export function defaultSlopeFactor(grade: number): number {
  if (!Number.isFinite(grade)) return 1;
  if (grade >= 0) return 1 + 7.5 * grade;
  const g = -grade;
  return g <= 0.1 ? 1 - 1.5 * g : 0.85 + 3 * (g - 0.1);
}

export const DEFAULT_COST_MODEL: CostModel = {
  id: "default-1",
  calibrated: false,
  classFactor: COST_CLASSES.map((c) => FACTORS[c]),
  slopeFactor: defaultSlopeFactor,
};

/** Distance only: every passable cell costs its length (the shortest legal route). */
export const SHORTEST_COST_MODEL: CostModel = {
  id: "shortest",
  calibrated: true,
  classFactor: COST_CLASSES.map((c) => (c === "blocked" || c === "blockedSoft" ? Infinity : 1)),
  slopeFactor: () => 1,
};
