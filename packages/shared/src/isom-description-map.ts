/**
 * ISOM 2017-2 map symbol → IOF control-description column D.
 *
 * The course editor's description autodetect searches the base map's OCAD
 * objects around a placed control and proposes the feature it sits on. An
 * OCAD symbol number encodes the ISOM number as `isom × 1000 + variant`
 * (ISOM 105.1 → 105001), so the lookup key is `Math.floor(sym / 1000)`.
 *
 * Values are the *canonical OCAD codes* Oxygen stores in
 * `controls.description` (see `control-description-options.ts` in the web
 * package) — e.g. boulder → `"2.004"`, which renders as IOF symbol 2.4.
 * A web unit test resolves every entry through the same OCAD→IOF
 * converters the description sheet uses, so a wrong code fails loudly.
 *
 * Lives in `shared` precisely so both the API (which does the search) and
 * that web test can see it.
 *
 * Deliberately incomplete: symbols that are never control features
 * (contours, magnetic north lines, course overprint) or that have no
 * column-D equivalent (cultivated land, orchards) are left out — a
 * missing entry simply means "no suggestion", which beats a wrong one.
 */

export interface IsomDescriptionEntry {
  /** Canonical OCAD column-D code, e.g. "2.004" (boulder). */
  d: string;
  /**
   * ISOM geometry of the symbol. Informational — the actual geometry of a
   * matched object comes from its OCAD object type — but it documents why
   * `g` is set where it is.
   */
  kind: "point" | "line" | "area";
  /**
   * Propose a column-G side-of direction ("N side of the boulder") for
   * this feature. Only meaningful for features with a definite centre:
   * point symbols and compact areas like buildings.
   */
  g?: boolean;
}

export const ISOM_DESCRIPTION_MAP: Record<number, IsomDescriptionEntry> = {
  // ── Landforms (100) ──────────────────────────────────────
  104: { d: "1.004", kind: "line" },                 // Earth bank
  105: { d: "1.006", kind: "line" },                 // Earth wall (105.1/.2)
  106: { d: "1.006", kind: "line" },                 // Ruined earth wall
  107: { d: "1.007", kind: "line" },                 // Erosion gully
  108: { d: "1.008", kind: "line" },                 // Small erosion gully
  109: { d: "1.010", kind: "point", g: true },       // Small knoll
  110: { d: "1.010", kind: "point", g: true },       // Small elongated knoll
  111: { d: "1.013", kind: "point", g: true },       // Small depression
  112: { d: "1.014", kind: "point", g: true },       // Pit
  113: { d: "1.015", kind: "area" },                 // Broken ground
  114: { d: "1.015", kind: "area" },                 // Very broken ground
  115: { d: "6.001", kind: "point", g: true },       // Prominent landform feature

  // ── Rock and boulders (200) ──────────────────────────────
  201: { d: "2.001", kind: "line" },                 // Impassable cliff
  202: { d: "2.001", kind: "line" },                 // Cliff
  203: { d: "2.003", kind: "point", g: true },       // Rocky pit or cave
  204: { d: "2.004", kind: "point", g: true },       // Boulder
  205: { d: "2.004", kind: "point", g: true },       // Large boulder
  206: { d: "2.002", kind: "area", g: true },        // Gigantic boulder / rock pillar
  207: { d: "2.006", kind: "point", g: true },       // Boulder cluster
  208: { d: "2.005", kind: "area" },                 // Boulder field
  209: { d: "2.005", kind: "area" },                 // Dense boulder field
  210: { d: "2.007", kind: "area" },                 // Stony ground, slow running
  211: { d: "2.007", kind: "area" },                 // Stony ground, walk
  212: { d: "2.007", kind: "area" },                 // Stony ground, fight
  214: { d: "2.008", kind: "area" },                 // Bare rock
  215: { d: "2.010", kind: "line" },                 // Trench

  // ── Water and marsh (300) ────────────────────────────────
  301: { d: "3.001", kind: "area" },                 // Uncrossable body of water
  302: { d: "3.002", kind: "area" },                 // Shallow body of water
  303: { d: "3.003", kind: "point", g: true },       // Waterhole
  304: { d: "3.004", kind: "line" },                 // Crossable watercourse
  305: { d: "3.004", kind: "line" },                 // Small crossable watercourse
  306: { d: "3.005", kind: "line" },                 // Minor / seasonal water channel
  307: { d: "3.007", kind: "area" },                 // Uncrossable marsh
  308: { d: "3.007", kind: "area" },                 // Marsh
  309: { d: "3.006", kind: "line" },                 // Narrow marsh
  310: { d: "3.007", kind: "area" },                 // Indistinct marsh
  311: { d: "3.009", kind: "point", g: true },       // Well, fountain or water tank
  312: { d: "3.010", kind: "point", g: true },       // Spring
  313: { d: "6.001", kind: "point", g: true },       // Prominent water feature

  // ── Vegetation (400) ─────────────────────────────────────
  401: { d: "4.001", kind: "area" },                 // Open land
  402: { d: "4.002", kind: "area" },                 // Open land with scattered trees
  403: { d: "4.001", kind: "area" },                 // Rough open land
  404: { d: "4.002", kind: "area" },                 // Rough open land, scattered trees
  410: { d: "4.005", kind: "area" },                 // Vegetation: fight (thicket)
  415: { d: "4.007", kind: "line" },                 // Distinct cultivation boundary
  416: { d: "4.007", kind: "line" },                 // Distinct vegetation boundary
  417: { d: "4.009", kind: "point", g: true },       // Prominent large tree
  418: { d: "4.009", kind: "point", g: true },       // Prominent bush or tree
  419: { d: "6.001", kind: "point", g: true },       // Prominent vegetation feature

  // ── Man-made (500) ───────────────────────────────────────
  501: { d: "5.012", kind: "area" },                 // Paved area
  502: { d: "5.001", kind: "line" },                 // Wide road
  503: { d: "5.001", kind: "line" },                 // Road
  504: { d: "5.002", kind: "line" },                 // Vehicle track
  505: { d: "5.002", kind: "line" },                 // Footpath
  506: { d: "5.002", kind: "line" },                 // Small footpath
  507: { d: "5.002", kind: "line" },                 // Less distinct small footpath
  508: { d: "5.003", kind: "line" },                 // Narrow ride
  509: { d: "5.026", kind: "line" },                 // Railway
  510: { d: "5.005", kind: "line" },                 // Power line, cableway, skilift
  511: { d: "5.005", kind: "line" },                 // Major power line
  512: { d: "5.004", kind: "line", g: true },        // Bridge / tunnel
  513: { d: "5.008", kind: "line" },                 // Wall (513.1/.2)
  514: { d: "5.008", kind: "line" },                 // Ruined wall
  515: { d: "5.008", kind: "line" },                 // Impassable wall
  516: { d: "5.009", kind: "line" },                 // Fence
  517: { d: "5.009", kind: "line" },                 // Ruined fence
  518: { d: "5.009", kind: "line" },                 // Impassable fence
  519: { d: "5.010", kind: "point", g: true },       // Crossing point
  520: { d: "5.025", kind: "area" },                 // Area that shall not be entered
  521: { d: "5.011", kind: "area", g: true },        // Building
  522: { d: "5.011", kind: "area", g: true },        // Canopy
  523: { d: "5.013", kind: "area", g: true },        // Ruin
  524: { d: "5.015", kind: "point", g: true },       // High tower
  525: { d: "5.015", kind: "point", g: true },       // Small tower
  526: { d: "5.017", kind: "point", g: true },       // Cairn
  527: { d: "5.018", kind: "point", g: true },       // Fodder rack
  528: { d: "6.001", kind: "line" },                 // Prominent line feature
  529: { d: "6.001", kind: "line" },                 // Prominent impassable line feature
  530: { d: "6.001", kind: "point", g: true },       // Prominent man-made feature – ring
  531: { d: "6.002", kind: "point", g: true },       // Prominent man-made feature – x
  532: { d: "5.024", kind: "line", g: true },        // Stairway
};

/** ISOM symbol number for an OCAD symbol number (105001 → 105). */
export function isomNumber(ocadSym: number): number {
  return Math.floor(ocadSym / 1000);
}

/** Description entry for an OCAD symbol number, or null when unmapped. */
export function isomDescriptionFor(ocadSym: number): IsomDescriptionEntry | null {
  return ISOM_DESCRIPTION_MAP[isomNumber(ocadSym)] ?? null;
}
