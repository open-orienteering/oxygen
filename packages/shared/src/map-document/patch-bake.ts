/**
 * Promote's bake (docs/map-patches.md §5; row G12a): an event's corrections
 * made part of a club map version.
 *
 * A promoted version keeps its source file; its corrections are a **version
 * patch**, an ordered list of immutable **layers** (§5 answer 3), which the
 * import applies to the matched `MapDocumentInput` before it is encoded
 * (`bakeVersionPatch`), so every re-import of the version re-applies them.
 * A layer is self-contained (answer 2): targets by `sourceIndex`, each
 * referenced document symbol as a `SymbolAnchor`, coordinates with their
 * `unitsPerMm`, patch symbols by library entry id (materialised again at
 * every bake, as re-resolution does). No base document is kept for it.
 *
 * In the baked document hidden objects are gone, an added object has
 * `sourceIndex = BAKED_SOURCE_INDEX_BASE + n` (`n` counts the add ops of
 * every layer in layer order, then op-id order, a skipped add included, so
 * numbers never shift), and patch symbols are entries of the symbol table.
 *
 * Pure TypeScript; no Node APIs.
 */

import { z } from "zod";
import type { MapDocument, MapDocumentInput, MapObjectInput } from "./codec.js";
import { OBJECT_TYPE, type DocumentSymbolInput, type MapDocumentHeader } from "./header.js";
import { materialiseSymbol } from "./materialise.js";
import {
  SYMBOL_TABLE_MAX,
  applyPatch,
  geometryValid,
  patchCoordSchema,
  patchOpId,
  symbolAnchorSchema,
  symbolKindOfType,
  type MapPatch,
  type PatchIssue,
  type PatchIssueCode,
  type PatchOp,
  type SymbolAnchor,
} from "./patch.js";
import { symbolAnchor } from "./patch-resolve.js";

/** The first `sourceIndex` of a baked added object (§5 answer 3; widens map-document-format §2.4). */
export const BAKED_SOURCE_INDEX_BASE = 0x80000000;

// ---- schema ----------------------------------------------------------------

const coordsSchema = z.array(patchCoordSchema).min(1);
const angleSchema = z.number().int().min(-32768).max(32767);
const sourceIndexSchema = z.number().int().min(0).max(0xfffffffe);
const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "lower-case UUID");

/** A document symbol by anchor, or a patch symbol by its library entry id (one of the layer's `symbols`). */
export const layerSymbolRefSchema = z.union([
  z.strictObject({ doc: symbolAnchorSchema }),
  z.strictObject({ patch: z.string().min(1) }),
]);
export type LayerSymbolRef = z.output<typeof layerSymbolRefSchema>;

/** An event op as a layer stores it: `{ doc: <index> }` became `{ doc: <anchor> }`. */
export const layerOpSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("hide"), sourceIndex: sourceIndexSchema }),
  z.strictObject({ op: z.literal("modify"), sourceIndex: sourceIndexSchema, coords: coordsSchema, angle: angleSchema.optional() }),
  z.strictObject({ op: z.literal("resymbol"), sourceIndex: sourceIndexSchema, symbol: layerSymbolRefSchema }),
  z.strictObject({
    op: z.literal("add"),
    id: uuidSchema,
    type: z.union([z.literal(OBJECT_TYPE.point), z.literal(OBJECT_TYPE.line), z.literal(OBJECT_TYPE.area)]),
    symbol: layerSymbolRefSchema,
    coords: coordsSchema,
    angle: angleSchema.optional(),
  }),
]);
export type LayerOp = z.output<typeof layerOpSchema>;

/** One promote's corrections (§5). Keys are the event's op ids. */
export const versionPatchLayerSchema = z
  .strictObject({
    /** The native unit the coordinates are in. */
    unitsPerMm: z.number().int().positive(),
    ops: z.record(z.string(), layerOpSchema),
    /** The patch symbols the ops reference, by library entry id, sorted. */
    symbols: z.array(z.string().min(1)).default([]),
  })
  .superRefine((l, ctx) => {
    for (const [key, op] of Object.entries(l.ops)) {
      const id = patchOpId(op as PatchOp);
      if (id !== key) ctx.addIssue({ code: "custom", path: ["ops", key], message: `key must be the op id ${id}` });
    }
  });
export type VersionPatchLayer = z.output<typeof versionPatchLayerSchema>;

/** `club_map_versions.patch`, `map_import_jobs.patch`, `map_documents.patch`: layers in promote order. */
export const versionPatchSchema = z.array(versionPatchLayerSchema);
export type VersionPatch = z.output<typeof versionPatchSchema>;

/** The stored JSON as a version patch; `null` and an unparseable value are none (`[]`). */
export function parseVersionPatch(value: unknown): VersionPatch {
  if (value === null || value === undefined) return [];
  const parsed = versionPatchSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** The same layers (key order ignored); null and `[]` are equal. */
export function sameVersionPatch(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? []) === canonicalJson(b ?? []);
}

function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const o = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  });
}

/** The number of ops over every layer (the club card's "n corrections", §5 answer 8). */
export function versionPatchOpCount(patch: VersionPatch): number {
  return patch.reduce((n, l) => n + Object.keys(l.ops).length, 0);
}

// ---- a layer from an event's patch (promote) ---------------------------------

export interface PromotedLayer {
  layer: VersionPatchLayer;
  /** The event op ids the layer holds: what promote removes from the event's patch (§5 answer 5). */
  promoted: string[];
  /** Ops that do not apply to `doc` and stay in the event's patch. */
  skipped: PatchIssue[];
}

/**
 * The layer promote stores (§5 answers 2, 5): the ops of `patch` that apply
 * to `doc` — the pinned document the patch is keyed onto — taken as if the
 * patch were enabled, `{ doc }` references as anchors, the referenced patch
 * symbols by key. Unresolved entries are not ops and stay. Null when no op
 * applies. Deterministic in the patch's content.
 */
export function versionLayerOfPatch(doc: MapDocument, patch: MapPatch): PromotedLayer | null {
  const { issues } = applyPatch(doc, { ...patch, enabled: true });
  const skippedIds = new Set(issues.map((i) => i.opId));
  const ops: Record<string, LayerOp> = {};
  const symbols = new Set<string>();
  const ref = (r: { doc: number } | { patch: string }): LayerSymbolRef => {
    if ("patch" in r) {
      symbols.add(r.patch);
      return { patch: r.patch };
    }
    // applyPatch found the index, so the anchor exists.
    return { doc: symbolAnchor(doc, r.doc)! };
  };
  for (const id of Object.keys(patch.ops).sort()) {
    if (skippedIds.has(id)) continue;
    const op = patch.ops[id];
    if (op.op === "resymbol") ops[id] = { ...op, symbol: ref(op.symbol) };
    else if (op.op === "add") ops[id] = { ...op, symbol: ref(op.symbol) };
    else ops[id] = op;
  }
  const promoted = Object.keys(ops);
  if (promoted.length === 0) return null;
  return { layer: { unitsPerMm: doc.header.unitsPerMm, ops, symbols: [...symbols].sort() }, promoted, skipped: issues };
}

// ---- the bake (the import's store stage) -------------------------------------

export interface BakeIssue {
  /** Index of the layer in the version patch. */
  layer: number;
  opId: string;
  code: PatchIssueCode;
}

export interface BakedInput {
  /** `input` itself when there are no layers. */
  input: MapDocumentInput;
  /** Ops that no longer apply, in layer then op-id order; the rest still apply (§5 defaults: `PATCH_ISSUE`). */
  issues: BakeIssue[];
  stats: { hidden: number; modified: number; resymbolled: number; added: number; symbols: number };
}

type SymbolLike = Pick<DocumentSymbolInput, "code" | "name" | "kind" | "sourceIndex">;

/**
 * A document symbol by anchor in the table being baked (the same-source
 * rule of §4.2): by its source position and kind; an anchor without one (a
 * baked patch symbol) by code, name and kind among entries without a
 * source position; else the first of the same code and kind.
 */
function findAnchored(symbols: readonly SymbolLike[], a: SymbolAnchor): number | undefined {
  let i = -1;
  if (a.sourceIndex !== undefined) i = symbols.findIndex((s) => s.sourceIndex === a.sourceIndex && s.kind === a.kind);
  else i = symbols.findIndex((s) => s.sourceIndex === undefined && s.code === a.code && s.name === a.name && s.kind === a.kind);
  if (i < 0) i = symbols.findIndex((s) => s.code === a.code && s.kind === a.kind);
  return i < 0 ? undefined : i;
}

const flatCoords = (coords: readonly (readonly number[])[], ratio: number): { coords: number[]; flags: number[] } => {
  const out: number[] = [];
  const flags: number[] = [];
  for (const c of coords) {
    out.push(ratio === 1 ? c[0] : Math.round(c[0] * ratio), ratio === 1 ? c[1] : Math.round(c[1] * ratio));
    flags.push(c[2] ?? 0);
  }
  return { coords: out, flags };
};

/**
 * Applies a version patch to a matched import input before encoding (§5):
 * layer by layer, each layer's ops in op-id order against the objects the
 * earlier layers left (hide, then drop at the layer's end; modify with
 * coordinates rescaled to the input's unit; resymbol; add). Patch symbols
 * are materialised for the input's header and appended to the table once
 * per key, without `match` or `sourceIndex`. An op that no longer applies is
 * an issue and skipped. Pure: `input` is not mutated, and the result is a
 * function of the input and the layers' content.
 */
export function bakeVersionPatch(input: MapDocumentInput, layers: VersionPatch): BakedInput {
  const stats = { hidden: 0, modified: 0, resymbolled: 0, added: 0, symbols: 0 };
  if (layers.length === 0) return { input, issues: [], stats };

  const unitsPerMm = input.header.unitsPerMm;
  const symbols: DocumentSymbolInput[] = [...input.header.symbols];
  const patchSymbolIdx = new Map<string, number>();
  const failedKeys = new Set<string>();
  const overflowKeys = new Set<string>();
  // materialiseSymbol reads the colour stack, the library, documentFactor and mapScale of the header.
  const headerView = {
    header: { ...input.header, documentFactor: input.header.documentFactor ?? 1, library: input.header.library ?? null } as unknown as MapDocumentHeader,
  };
  let objects: MapObjectInput[] = [...input.objects];
  const issues: BakeIssue[] = [];
  let addCount = 0;

  layers.forEach((layer, li) => {
    const report = (opId: string, code: PatchIssueCode) => issues.push({ layer: li, opId, code });
    for (const key of [...layer.symbols].sort()) {
      if (patchSymbolIdx.has(key) || failedKeys.has(key) || overflowKeys.has(key)) continue;
      if (symbols.length >= SYMBOL_TABLE_MAX) {
        overflowKeys.add(key);
        continue;
      }
      const m = materialiseSymbol(headerView, key);
      if (!m.ok) {
        failedKeys.add(key);
        continue;
      }
      patchSymbolIdx.set(key, symbols.length);
      symbols.push({ ...m.symbol });
      stats.symbols++;
    }
    const resolve = (r: LayerSymbolRef, type: number): number | PatchIssueCode => {
      let idx: number | undefined;
      if ("doc" in r) idx = findAnchored(symbols, r.doc);
      else {
        idx = patchSymbolIdx.get(r.patch);
        if (idx === undefined) return overflowKeys.has(r.patch) ? "symbol-table-full" : "symbol-missing";
      }
      if (idx === undefined) return "symbol-missing";
      return symbols[idx].kind === symbolKindOfType(type) ? idx : "kind-mismatch";
    };

    const ratio = unitsPerMm / layer.unitsPerMm;
    const bySource = new Map<number, number>();
    objects.forEach((o, i) => bySource.set(o.sourceIndex, i));
    const drop = new Set<number>();
    const next = [...objects];
    const added: MapObjectInput[] = [];

    for (const id of Object.keys(layer.ops).sort()) {
      const op = layer.ops[id];
      if (op.op === "add") {
        const n = addCount++;
        const s = resolve(op.symbol, op.type);
        if (typeof s === "string") report(id, s);
        else if (!geometryValid(op.type, op.coords.length)) report(id, "geometry-invalid");
        else {
          const g = flatCoords(op.coords, ratio);
          added.push({ symbolIdx: s, type: op.type, angleDeciDeg: op.angle ?? 0, sourceIndex: BAKED_SOURCE_INDEX_BASE + n, coords: g.coords, flags: g.flags });
          stats.added++;
        }
        continue;
      }
      const i = bySource.get(op.sourceIndex);
      if (i === undefined) {
        report(id, "target-missing");
        continue;
      }
      const o = next[i];
      if (op.op === "hide") {
        drop.add(i);
        stats.hidden++;
      } else if (op.op === "resymbol") {
        const s = resolve(op.symbol, o.type);
        if (typeof s === "string") report(id, s);
        else {
          next[i] = { ...o, symbolIdx: s };
          stats.resymbolled++;
        }
      } else if (!geometryValid(o.type, op.coords.length, o.coords.length / 2)) report(id, "geometry-invalid");
      else {
        const g = flatCoords(op.coords, ratio);
        next[i] = { ...o, coords: g.coords, flags: g.flags, ...(op.angle !== undefined ? { angleDeciDeg: op.angle } : {}) };
        stats.modified++;
      }
    }
    objects = [...next.filter((_, i) => !drop.has(i)), ...added];
  });

  return { input: { header: { ...input.header, symbols }, objects }, issues, stats };
}
