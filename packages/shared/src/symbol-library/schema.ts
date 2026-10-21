/**
 * Canonical symbol library — entry and library schemas (03 §6.4).
 * Normative: docs/map-symbols.md §2.
 *
 * An entry's `render` is the `RenderSymbol` IR with two differences: colours
 * are palette ids (strings) instead of colour-stack indices, and `id` /
 * `code` / `name` are carried by the entry rather than repeated. `resolve`
 * turns an entry into a plain `RenderSymbol` against a colour index.
 */

import { z } from "zod";
import { type RenderSymbol, type RenderSymbolInput, parseRenderSymbol } from "../render/symbol.js";
import { type PaletteEdition, type SpecId, paletteIndex } from "./palette.js";

/** Keys of the IR that hold a colour reference. */
const COLOUR_KEYS: ReadonlySet<string> = new Set(["colour", "fill", "backgroundColour"]);

/**
 * `T` with every colour reference re-typed as a palette id. Distributes
 * over unions, so applying it to `RenderSymbolInput` keeps the discriminant.
 */
export type Colourised<T> = T extends readonly (infer U)[]
  ? Colourised<U>[]
  : T extends object
    ? { [K in keyof T]: K extends "colour" | "fill" | "backgroundColour" ? ReplaceNumber<T[K]> : Colourised<T[K]> }
    : T;
type ReplaceNumber<V> = V extends number ? string : V extends undefined ? undefined : V;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What an entry's `render` field is authored as. */
export type LibraryRender = Colourised<DistributiveOmit<RenderSymbolInput, "id" | "code" | "name">>;

export const specIdSchema = z.enum(["ISOM2017-2", "ISSprOM2019-2", "ISSkiOM2019", "ISMTBOM2022"]);
export const paletteEditionSchema = z.enum(["iof2022", "iof2024"]);

/** `516`, `105.1`, `501.10`. */
export const symbolCodeSchema = z.string().regex(/^\d{3}(\.\d{1,2})?$/);

export const libraryEntrySchema = z.object({
  /** `<library>:<code>` or `<library>:<code>.<variant>`. */
  id: z.string().regex(/^[A-Za-z0-9-]+:\d{3}(\.\d{1,2})?(\.[a-z])?$/),
  code: symbolCodeSchema,
  /** `b`… for drawable variants under one heading; `null` for the heading's own drawing. */
  variant: z.string().regex(/^[a-z]$/).nullable(),
  name: z.object({ en: z.string().min(1), sv: z.string().min(1).optional() }),
  /** When a variant applies (plain English, authoring aid for the matcher's review UI). */
  description: z.string().optional(),
  /** The spec's P / L / A / T. Multi-typed headings (`L, T`) split into one entry per drawing. */
  specType: z.enum(["P", "L", "A", "T"]),
  purpleRole: z.enum(["lower", "upper"]).nullable(),
  /** Point symbols: `north` (never rotated) or `object` (follows the object's angle). */
  orientation: z.enum(["north", "object"]).nullable(),
  /** Graphical minimum dimensions from the spec, µm / µm² at the reference scale. */
  minimum: z
    .object({ lengthUm: z.number().positive().optional(), widthUm: z.number().positive().optional(), areaUm2: z.number().positive().optional() })
    .optional(),
  /** Informational: the spec's stated ground footprint of the minimum, metres. */
  footprintM: z.number().positive().optional(),
  aliases: z.array(z.object({ library: z.string(), code: symbolCodeSchema })),
  /** The IR with palette ids as colours; validated by resolving against the library's palette. */
  render: z.custom<LibraryRender>((v) => typeof v === "object" && v !== null && "type" in v),
  /** Where the spec left a detail to the drawing tool and which behaviour was picked (03 §6.4). */
  notes: z.string().optional(),
  source: z.string().min(1),
});

export type LibraryEntry = z.output<typeof libraryEntrySchema>;
export type LibraryEntryInput = z.input<typeof libraryEntrySchema>;

export const symbolLibrarySchema = z.object({
  id: z.string().min(1),
  spec: specIdSchema,
  revision: z.string().min(1),
  /** Denominator of the reference scale the dimensions are stated at. */
  referenceScale: z.number().int().positive(),
  /** Edition of the colour palette the library was authored against. */
  palette: paletteEditionSchema,
  entries: z.array(libraryEntrySchema).min(1),
});

export type SymbolLibrary = z.output<typeof symbolLibrarySchema>;

/** Older specs an entry's `aliases` may name (docs/map-symbols.md §3). The 2007 sprint spec was ISSOM. */
export const ALIAS_LIBRARIES = ["ISOM2000", "ISSOM2007"] as const;
const ALIAS_LIBRARY_SET: ReadonlySet<string> = new Set(ALIAS_LIBRARIES);

/** Every palette id referenced by an entry's render tree. */
export function colourRefs(render: unknown, out = new Set<string>()): Set<string> {
  walk(render, (key, value) => {
    if (COLOUR_KEYS.has(key) && typeof value === "string") out.add(value);
  });
  return out;
}

function walk(node: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      visit(k, v);
      walk(v, visit);
    }
  }
}

function replaceColours(node: unknown, lookup: (id: string) => number): unknown {
  if (Array.isArray(node)) return node.map((n) => replaceColours(n, lookup));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = COLOUR_KEYS.has(k) && typeof v === "string" ? lookup(v) : replaceColours(v, lookup);
    }
    return out;
  }
  return node;
}

export class UnknownPaletteIdError extends Error {
  readonly entryId: string;
  readonly paletteId: string;

  constructor(entryId: string, paletteId: string) {
    super(`${entryId}: palette id "${paletteId}" is not in the colour index`);
    this.entryId = entryId;
    this.paletteId = paletteId;
  }
}

/**
 * Resolve one entry to a `RenderSymbol`: palette ids → indices via
 * `colourIndex`, `id` / `code` / `name` copied from the entry, then the IR's
 * own parse applies defaults and validates.
 */
export function resolveEntry(entry: LibraryEntry, colourIndex: ReadonlyMap<string, number>): RenderSymbol {
  const lookup = (id: string): number => {
    const idx = colourIndex.get(id);
    if (idx === undefined) throw new UnknownPaletteIdError(entry.id, id);
    return idx;
  };
  const render = replaceColours(entry.render, lookup) as Record<string, unknown>;
  return parseRenderSymbol({ ...render, id: entry.id, code: entry.code, name: entry.name.en });
}

/** `resolveEntry` for a whole library against its own spec's palette. */
export function resolveLibrary(library: SymbolLibrary, edition: PaletteEdition = library.palette): RenderSymbol[] {
  const index = paletteIndex(edition, library.spec);
  return library.entries.map((e) => resolveEntry(e, index));
}

export interface LibraryProblem {
  entryId: string;
  message: string;
}

/**
 * Authoring checks beyond the Zod shape: unique ids, id ⇔ code/variant
 * agreement, every colour in the spec's palette, and every render parsing
 * as a `RenderSymbol`. Returned, not thrown, so a test can list them all.
 */
export function validateLibrary(library: SymbolLibrary): LibraryProblem[] {
  const problems: LibraryProblem[] = [];
  const index = paletteIndex(library.palette, library.spec);
  const seen = new Set<string>();
  const headingSv = new Map<string, string | undefined>();
  for (const e of library.entries) if (e.variant === null) headingSv.set(e.code, e.name.sv);
  for (const e of library.entries) {
    const expectedId = `${library.id}:${e.code}${e.variant ? `.${e.variant}` : ""}`;
    if (e.id !== expectedId) problems.push({ entryId: e.id, message: `id should be ${expectedId}` });
    if (seen.has(e.id)) problems.push({ entryId: e.id, message: "duplicate id" });
    seen.add(e.id);
    for (const c of colourRefs(e.render)) {
      if (!index.has(c)) problems.push({ entryId: e.id, message: `palette id "${c}" is not in ${library.palette} for ${library.spec}` });
    }
    const is7xx = e.code.startsWith("7");
    if (is7xx && !e.purpleRole) problems.push({ entryId: e.id, message: "course symbols need a purpleRole" });
    if (!is7xx && e.purpleRole) problems.push({ entryId: e.id, message: "purpleRole is only for 7xx" });
    if (e.render.type === "point" && !e.orientation) problems.push({ entryId: e.id, message: "point symbols need an orientation" });
    if (e.render.type !== "point" && e.orientation) problems.push({ entryId: e.id, message: "orientation is only for point symbols" });
    const aliasKeys = new Set<string>();
    for (const a of e.aliases) {
      if (!ALIAS_LIBRARY_SET.has(a.library)) problems.push({ entryId: e.id, message: `alias library "${a.library}" is not one of ${ALIAS_LIBRARIES.join(", ")}` });
      const key = `${a.library} ${a.code}`;
      if (aliasKeys.has(key)) problems.push({ entryId: e.id, message: `duplicate alias ${key}` });
      aliasKeys.add(key);
    }
    if (e.variant !== null && e.aliases.length > 0) problems.push({ entryId: e.id, message: "aliases are for heading entries only" });
    if (e.variant !== null && e.name.sv !== undefined) {
      const sv = headingSv.get(e.code);
      if (sv === undefined) problems.push({ entryId: e.id, message: "variant has a Swedish name but its heading has none" });
      else if (!e.name.sv.startsWith(`${sv}, `) || e.name.sv.length <= sv.length + 2) {
        problems.push({ entryId: e.id, message: `variant name should start with "${sv}, "` });
      }
    }
    try {
      resolveEntry(e, index);
    } catch (err) {
      problems.push({ entryId: e.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return problems;
}

/** Parse and run the authoring checks; throws with every problem listed. */
export function parseSymbolLibrary(input: unknown): SymbolLibrary {
  const lib = symbolLibrarySchema.parse(input);
  const problems = validateLibrary(lib);
  if (problems.length > 0) {
    throw new Error(`symbol library ${lib.id}: ${problems.map((p) => `${p.entryId}: ${p.message}`).join("; ")}`);
  }
  return lib;
}

export type { SpecId, PaletteEdition };
