/**
 * Stages 6–7 of the import (06 §4.1) over a normalised document input:
 * choose the library, classify colours, detect the document factor, match
 * every source symbol, align the colour stack and rewrite the input so the
 * encoder produces the *final* document (06 §4.2). Pure; runs in Node and
 * in a browser worker. Normative: docs/map-symbols.md §9.
 */

import type { MapDocumentInput } from "../map-document/codec.js";
import type { DocumentSymbolInput, DocumentWarning } from "../map-document/header.js";
import { parseRenderSymbol, type RenderSymbol } from "../render/symbol.js";
import { reindexRenderColours, remapRenderColours, renderColourRefs } from "../render/transform.js";
import { getLibraryEntry, getSymbolLibrary, SYMBOL_LIBRARY_VERSION, type SymbolLibraryId } from "../symbol-library/index.js";
import type { PaletteEdition } from "../symbol-library/palette.js";
import { colourRefs } from "../symbol-library/schema.js";
import { alignColourStack, identifySourceColours, type PurpleDisplaced } from "./colour-align.js";
import { detectPaletteEdition, formatClass } from "./colour-class.js";
import { buildColourLayers, ColourLayersError, type ColourLayersReport, type ColourLayersResult, deviationKey, type DeviationChoice, symbolColourUses } from "./colour-layers.js";
import { rolePalette } from "./colour-roles.js";
import { canonicalCandidates, chooseLibrary, detectDocumentFactor, type FactorDetection, MATCH_THRESHOLDS, matchContext, matchSymbol, type SymbolDecision } from "./matcher.js";

export interface MatchDocumentOptions {
  /** Force a library instead of choosing by scale. */
  library?: SymbolLibraryId;
  /** Force the palette edition instead of detecting it from the colour table. */
  edition?: PaletteEdition;
  /** Force the document factor (03 §6.6 override). */
  factor?: number;
  decisions?: readonly SymbolDecision[];
  /**
   * Stage 7's colour order (docs/map-symbols.md §9.3 "In the importer", row I5): `iof`, the layered stack
   * (`buildColourLayers`, the default), or `source`, the mapper's table (§9.2, the user's per-map switch back).
   */
  colourOrder?: ColourOrder;
  /** `iof` only: per deviation key (`"upper>lower"`), keep or drop, overriding the defaults (§9.3 "Deviations"). */
  deviations?: Readonly<Record<string, DeviationChoice>>;
}

/** The two colour orders of stage 7 (§9.3 answer 1). */
export type ColourOrder = "iof" | "source";
export const DEFAULT_COLOUR_ORDER: ColourOrder = "iof";

export interface MatchingSummary {
  library: { id: string; version: string };
  edition: PaletteEdition;
  thresholds: typeof MATCH_THRESHOLDS;
  factor: FactorDetection;
  /** Source symbols with a render definition, by outcome. */
  symbols: { auto: number; suggested: number; unmatched: number; variant: number; reviewed: number };
  /** Objects of those symbols, by outcome; `variant` is the part of `unmatched` kept as source by design. */
  objects: { auto: number; suggested: number; unmatched: number; variant: number };
  byMethod: Record<string, number>;
  scaleAnomalies: { code: string; name: string; factor: number; canonicalId: string }[];
}

export interface ColourStackSummary {
  source: number;
  inserted: string[];
  aliased: { paletteId: string; viaPaletteId: string; sourceNumber?: number }[];
  conflicts: { colour: string; reason: string }[];
  /** Source colours used by a symbol but outside the IOF vocabulary. */
  unclassified: { sourceNumber?: number; name: string }[];
  /** Used area colours drawn above lower purple (docs/map-symbols.md §9.2 step 5). */
  areasAboveLowerPurple: { name: string; sourceNumber?: number; paletteId?: string }[];
  /** Source purples left in place as ordinary colours because they do not stand where the course purple goes (§9.2 step 4, C15). */
  purplesDisplaced: PurpleDisplaced[];
  /** The order the stack was built in (`header.colourOrder.order`). */
  order: ColourOrder;
  /** `iof` only: the layered stack's report (§9.3 "Layers" Output) less `inserted` and `aliased`, which are above. */
  layers?: Omit<ColourLayersReport, "inserted" | "aliased">;
}

export interface MatchDocumentResult {
  input: MapDocumentInput;
  matching: MatchingSummary;
  colourStack: ColourStackSummary;
  warnings: DocumentWarning[];
}

export function matchDocument(input: MapDocumentInput, opts: MatchDocumentOptions = {}): MatchDocumentResult {
  const { header, objects } = input;
  const libraryId = chooseLibrary(header.mapScale, opts.library);
  const library = getSymbolLibrary(libraryId);
  const colours = header.colours;
  const edition = opts.edition ?? detectPaletteEdition(colours);
  const infos = identifySourceColours(colours, library.spec, edition);
  const classOf = (i: number) => infos[i]?.class ?? null;

  const symbols = header.symbols;
  // Inputs may carry unparsed IR (defaults not applied); normalise once.
  const renders: (RenderSymbol | null)[] = symbols.map((s) => (s.render ? parseRenderSymbol(s.render) : null));
  const objectsPerSymbol = new Array<number>(symbols.length).fill(0);
  for (const o of objects) if (o.symbolIdx < objectsPerSymbol.length) objectsPerSymbol[o.symbolIdx]++;
  const usage = new Array<number>(colours.length).fill(0);
  renders.forEach((r, i) => {
    if (!r) return;
    for (const c of renderColourRefs(r)) {
      if (c < 0 || c >= colours.length) throw new Error(`matchDocument: symbol ${symbols[i].code} references colour index ${c} outside the ${colours.length}-entry colour table`);
      usage[c] += objectsPerSymbol[i];
    }
  });

  const canon = canonicalCandidates(library, edition);
  const sources = symbols.map((s, i) => ({ code: s.code, name: s.name, render: renders[i] }));
  const factor = detectDocumentFactor(sources.filter((_, i) => (symbols[i].origin ?? "source") === "source"), canon, classOf, header.mapScale, library.referenceScale, opts.factor);
  // Decisions name entries of one library; those of the other one do not apply here (docs/map-symbols.md §8.5).
  const decisions = opts.decisions?.filter((d) => d.libraryId === undefined || d.libraryId === libraryId);
  // With the map scale the overlay libraries are candidates too (docs/map-symbols.md §8.2, §12).
  const ctx = matchContext(libraryId, edition, factor.factor, classOf, decisions, header.mapScale);

  const summary: MatchingSummary = {
    library: { id: library.id, version: SYMBOL_LIBRARY_VERSION },
    edition,
    thresholds: MATCH_THRESHOLDS,
    factor,
    symbols: { auto: 0, suggested: 0, unmatched: 0, variant: 0, reviewed: 0 },
    objects: { auto: 0, suggested: 0, unmatched: 0, variant: 0 },
    byMethod: {},
    scaleAnomalies: [],
  };
  const warnings = new Map<string, DocumentWarning>();
  const warn = (code: string, message?: string) => {
    const w = warnings.get(code);
    if (w) w.count++;
    else warnings.set(code, { code, count: 1, message });
  };

  const needed = new Set<string>();
  const matched: DocumentSymbolInput[] = symbols.map((s, i) => {
    if ((s.origin ?? "source") !== "source") return s;
    const outcome = matchSymbol(sources[i], ctx);
    const m = outcome.match;
    if (renders[i]) {
      summary.symbols[m.state]++;
      summary.objects[m.state] += objectsPerSymbol[i];
      if (m.reviewed) summary.symbols.reviewed++;
      summary.byMethod[m.method] = (summary.byMethod[m.method] ?? 0) + 1;
      if (m.method === "variant") {
        summary.symbols.variant++;
        summary.objects.variant += objectsPerSymbol[i];
      } else if (m.state === "unmatched") warn("SYMBOL_UNMATCHED", "source symbols without a canonical match are drawn from their own definition");
    }
    if (outcome.scaleAnomaly) {
      summary.scaleAnomalies.push({ code: s.code, name: s.name, ...outcome.scaleAnomaly });
      warn("SYMBOL_SCALE_ANOMALY", "a symbol matches its spec code only at a different enlargement than the document");
    }
    if (outcome.unknownDecision) warn("DECISION_UNKNOWN_ENTRY", `decision names ${outcome.unknownDecision}`);
    if (m.state === "auto" && m.canonicalId) {
      const entry = getLibraryEntry(m.canonicalId);
      if (entry) for (const id of colourRefs(entry.render)) needed.add(id);
    }
    return { ...s, match: m };
  });

  // Stage 7: the layered stack (§9.3, `iof`) or the mapper's table (§9.2, `source`). A map whose layers cannot be
  // resolved is drawn in its own order, with a warning, rather than failing the import.
  let order: ColourOrder = opts.colourOrder ?? DEFAULT_COLOUR_ORDER;
  let layered: ColourLayersResult | null = null;
  if (order === "iof") {
    const uses = symbolColourUses(
      matched.map((s, i) => ({ render: renders[i], match: s.match ?? null, origin: s.origin })),
      objectsPerSymbol,
      infos,
      rolePalette(library.spec, edition),
    );
    try {
      layered = buildColourLayers({ colours, infos, uses, needed, spec: library.spec, edition, ...(opts.deviations ? { deviations: opts.deviations } : {}) });
    } catch (e) {
      if (!(e instanceof ColourLayersError)) throw e;
      warn("COLOUR_LAYERS_FAILED", `${e.message}: drawn in the map's own colour order`);
      order = "source";
    }
  }

  let stack: Pick<ColourStackSummary, "inserted" | "aliased" | "conflicts" | "areasAboveLowerPurple" | "purplesDisplaced" | "layers">;
  let stackColours: MapDocumentInput["header"]["colours"];
  let remapped: DocumentSymbolInput[];
  let colourOrder: NonNullable<MapDocumentInput["header"]["colourOrder"]>;
  if (layered) {
    const rep = layered.report;
    const name = (source: number) => `"${colours[source].name}"`;
    for (const d of rep.deviations) {
      const pair = `${d.upper} over ${d.lower} (${d.objects.upper} / ${d.objects.lower} objects)`;
      if (d.blockedBy) warn("COLOUR_DEVIATION_BLOCKED", `${pair}: wanted in the map's order, drawn in the IOF order because of ${d.blockedBy.join(", ")}`);
      else if (d.kept) warn("COLOUR_DEVIATION_KEPT", `${pair}: drawn in the map's order${d.impliedBy ? ` (implied by ${d.impliedBy.join(", ") || "the map's own order"})` : d.byDefault ? " by default" : " by override"}`);
      else warn("COLOUR_DEVIATION_DROPPED", `${pair}: drawn in the IOF order${d.byDefault ? " by default" : " by override"}`);
    }
    for (const r of rep.noRole) if (r.objects > 0) warn("COLOUR_NO_ROLE", `${name(r.source)} (${r.place}) has no IOF layer and is drawn where the map's own order puts it`);
    for (const r of rep.sourceOrdered) {
      // A roleless line colour above lower purple is where the palette puts line colours; areas, masks and layout may hide the course.
      if (!r.aboveLowerPurple || r.objects === 0 || (r.reason === "no-role" && rep.rows[r.row].place !== "area")) continue;
      warn("COLOUR_SOURCE_ORDERED_ABOVE_LOWER_PURPLE", `${name(r.source)} (${r.reason}) is drawn above lower purple, where the map's own order puts it, and may hide the course overprint under it`);
    }
    const { inserted, aliased, ...lists } = rep;
    stack = { inserted, aliased, conflicts: [], areasAboveLowerPurple: [], purplesDisplaced: [], layers: lists };
    stackColours = layered.colours;
    remapped = matched.map((s, i) => (renders[i] ? { ...s, render: reindexRenderColours(renders[i]!, layered!.reindex.symbols[i]!) } : s));
    colourOrder = { order: "iof", kept: rep.deviations.filter((d) => d.kept).map((d) => deviationKey(d.upper, d.lower)).sort() };
  } else {
    const aligned = alignColourStack({ colours, infos, spec: library.spec, edition, needed, usage });
    for (const c of aligned.conflicts) warn("COLOUR_ORDER_CONFLICT", `${c.colour}: ${c.reason}`);
    for (const a of aligned.areasAboveLowerPurple) warn("COLOUR_AREA_ABOVE_LOWER_PURPLE", `"${a.name}" is drawn above lower purple and hides the course overprint under it`);
    stack = { inserted: aligned.inserted, aliased: aligned.aliased, conflicts: aligned.conflicts, areasAboveLowerPurple: aligned.areasAboveLowerPurple, purplesDisplaced: aligned.purplesDisplaced };
    stackColours = aligned.colours;
    remapped = matched.map((s, i) => (renders[i] ? { ...s, render: remapRenderColours(renders[i]!, aligned.remap) } : s));
    colourOrder = { order: "source" };
  }

  const unclassified: ColourStackSummary["unclassified"] = [];
  infos.forEach((info) => {
    if (info.class || usage[info.index] === 0) return;
    const c = colours[info.index];
    const e: ColourStackSummary["unclassified"][number] = { name: c.name };
    if (c.sourceNumber !== undefined) e.sourceNumber = c.sourceNumber;
    unclassified.push(e);
    warn("COLOUR_UNCLASSIFIED", `"${c.name}" (${formatClass(null)}) is used by symbols but is not an IOF colour`);
  });

  const out: MapDocumentInput = {
    header: {
      ...header,
      documentFactor: factor.factor,
      library: { id: library.id, version: SYMBOL_LIBRARY_VERSION },
      colours: stackColours,
      colourOrder,
      symbols: remapped,
      warnings: [...(header.warnings ?? []), ...warnings.values()],
    },
    objects,
  };
  return {
    input: out,
    matching: summary,
    colourStack: { source: colours.length, ...stack, unclassified, order },
    warnings: [...warnings.values()],
  };
}
