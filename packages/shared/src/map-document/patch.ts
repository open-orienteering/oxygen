/**
 * Map patch — an event's corrections to its pinned document and their
 * application (docs/map-patches.md §1–2; research 08 §4.1, §4.7).
 *
 * A patch is a set of keyed states (`hide:<sourceIndex>`,
 * `modify:<sourceIndex>`, `resymbol:<sourceIndex>`, `add:<uuid>`), merged
 * per op id (`mergePatch`) and applied on top of the immutable document
 * (`applyPatch`) to give the effective document every consumer draws.
 *
 * Pure TypeScript; no Node APIs.
 */

import { z } from "zod";
import { renderSymbolSchema } from "../render/symbol.js";
import type { MapDocument, ObjectAttrs } from "./codec.js";
import { OBJECT_TYPE, documentSymbolSchema, type DocumentSymbol } from "./header.js";

// ---- schema ----------------------------------------------------------------

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;
/** `attrs.symbolIdx` is u16 (map-document-format §2.4). */
const SYMBOL_TABLE_MAX = 0x10000;
/** `sourceIndex` of an added object — no source object has it (map-patches §2.2). */
export const ADDED_SOURCE_INDEX = 0xffffffff;

const coordValue = z.number().int().min(INT32_MIN).max(INT32_MAX);
/** `[x, y]` or `[x, y, flags]`, document native units — the JSON projection's form (map-document-format §7). */
export const patchCoordSchema = z.union([
  z.tuple([coordValue, coordValue]),
  z.tuple([coordValue, coordValue, z.number().int().min(0).max(255)]),
]);
export type PatchCoord = z.output<typeof patchCoordSchema>;

const coordsSchema = z.array(patchCoordSchema).min(1);
/** Rotation in 0.1°, as `attrs.angle` (int16). */
const angleSchema = z.number().int().min(-32768).max(32767);
const sourceIndexSchema = z.number().int().min(0).max(ADDED_SOURCE_INDEX - 1);
/** Lower-case UUID: op ids are compared as strings. */
const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "lower-case UUID");

/** A symbol of the pinned document (`doc`: index into its table) or of the patch (`patch`: key into `symbols`). */
export const patchSymbolRefSchema = z.union([
  z.strictObject({ doc: z.number().int().min(0) }),
  z.strictObject({ patch: z.string().min(1) }),
]);
export type PatchSymbolRef = z.output<typeof patchSymbolRefSchema>;

export const patchOpSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("hide"), sourceIndex: sourceIndexSchema }),
  z.strictObject({ op: z.literal("modify"), sourceIndex: sourceIndexSchema, coords: coordsSchema, angle: angleSchema.optional() }),
  z.strictObject({ op: z.literal("resymbol"), sourceIndex: sourceIndexSchema, symbol: patchSymbolRefSchema }),
  z.strictObject({
    op: z.literal("add"),
    id: uuidSchema,
    /** Point, line or area: no text creation (slice G). */
    type: z.union([z.literal(OBJECT_TYPE.point), z.literal(OBJECT_TYPE.line), z.literal(OBJECT_TYPE.area)]),
    symbol: patchSymbolRefSchema,
    coords: coordsSchema,
    angle: angleSchema.optional(),
  }),
]);
export type PatchOp = z.output<typeof patchOpSchema>;

/** A materialised symbol: a document symbol without `match` (drawn from its own `render`, map-patches §1.3). */
export const patchSymbolSchema = documentSymbolSchema.omit({ match: true, sourceIndex: true }).extend({ render: renderSymbolSchema });
export type PatchSymbol = z.output<typeof patchSymbolSchema>;

/** The op id: one state per `(target, kind)` (map-patches §1.1). */
export function patchOpId(op: PatchOp): string {
  return op.op === "add" ? `add:${op.id}` : `${op.op}:${op.sourceIndex}`;
}

export const mapPatchSchema = z
  .object({
    /** The document the ops are keyed onto. */
    documentHash: z.string().regex(/^[0-9a-f]{64}$/),
    enabled: z.boolean().default(true),
    ops: z.record(z.string(), patchOpSchema).default({}),
    /** Keyed by the full library entry id the symbol was materialised from. */
    symbols: z.record(z.string().min(1), patchSymbolSchema).default({}),
  })
  .superRefine((p, ctx) => {
    for (const [key, op] of Object.entries(p.ops)) {
      if (patchOpId(op) !== key) ctx.addIssue({ code: "custom", path: ["ops", key], message: `key must be the op id ${patchOpId(op)}` });
    }
  });
export type MapPatch = z.output<typeof mapPatchSchema>;
export type MapPatchInput = z.input<typeof mapPatchSchema>;

/** `mapPatch.apply`'s body (row G3) and the client's optimistic change (map-patches §1.5). */
export const patchChangeSchema = z
  .object({
    put: z.array(patchOpSchema).default([]),
    remove: z.array(z.string().min(1)).default([]),
    putSymbols: z.record(z.string().min(1), patchSymbolSchema).default({}),
  })
  .superRefine((c, ctx) => {
    const put = new Set<string>();
    c.put.forEach((op, i) => {
      const id = patchOpId(op);
      if (put.has(id)) ctx.addIssue({ code: "custom", path: ["put", i], message: `op ${id} put twice` });
      put.add(id);
    });
    c.remove.forEach((id, i) => {
      if (put.has(id)) ctx.addIssue({ code: "custom", path: ["remove", i], message: `op ${id} both put and removed` });
    });
  });
/** A parsed change; `put`, `remove` and `putSymbols` may be left out. */
export interface PatchChange {
  put?: PatchOp[];
  remove?: string[];
  putSymbols?: Record<string, PatchSymbol>;
}

const sortedRecord = <T>(entries: Iterable<[string, T]>): Record<string, T> =>
  Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * The per-op-id merge: `remove` drops ids (absent ones are no-ops), `put`
 * sets states by id, `putSymbols` sets symbols by key. Returns a new patch
 * with sorted keys; twice equals once, and changes to different ids commute.
 */
export function mergePatch(patch: MapPatch, change: PatchChange): MapPatch {
  const ops = new Map(Object.entries(patch.ops));
  for (const id of change.remove ?? []) ops.delete(id);
  for (const op of change.put ?? []) ops.set(patchOpId(op), op);
  const symbols = new Map(Object.entries(patch.symbols));
  for (const [key, sym] of Object.entries(change.putSymbols ?? {})) symbols.set(key, sym);
  return { ...patch, ops: sortedRecord(ops), symbols: sortedRecord(symbols) };
}

// ---- application -----------------------------------------------------------

/** A decoded document with a patch applied (map-patches §2.2); an unpatched `MapDocument` is one too. */
export interface EffectiveDocument extends MapDocument {
  /** 1 = hidden by the patch. Absent on an unpatched document. Every reader skips these. */
  readonly hidden?: Uint8Array;
  /** Present when a patch was applied. */
  readonly patch?: {
    /** The pinned document's object count. */
    baseCount: number;
    /** The pinned document's symbol count. */
    baseSymbols: number;
    /** `added[k]` is the add id of object `baseCount + k`. */
    added: string[];
    /** `symbols[k]` is the patch symbol key at index `baseSymbols + k`. */
    symbols: string[];
  };
}

export type PatchIssueCode = "target-missing" | "symbol-missing" | "kind-mismatch" | "geometry-invalid" | "symbol-table-full";

export interface PatchIssue {
  opId: string;
  code: PatchIssueCode;
}

export interface AppliedPatch {
  document: EffectiveDocument;
  /** Ops that were skipped, in op-id order (map-patches §2.3). */
  issues: PatchIssue[];
}

/** The symbol kind an object type takes (map-patches §2.3). */
const symbolKindOfType = (type: number): DocumentSymbol["kind"] | undefined =>
  type === OBJECT_TYPE.point ? "point"
    : type === OBJECT_TYPE.line ? "line"
      : type === OBJECT_TYPE.area ? "area"
        : type === OBJECT_TYPE.text || type === OBJECT_TYPE.formattedText || type === OBJECT_TYPE.lineText ? "text"
          : type === OBJECT_TYPE.rectangle ? "rectangle"
            : undefined;

const isTextType = (type: number): boolean => symbolKindOfType(type) === "text";

/** Whether `coords` is a valid shape for an object of `type` that had `before` coordinates (map-patches §2.3). */
function geometryValid(type: number, n: number, before?: number): boolean {
  if (type === OBJECT_TYPE.point) return n === 1;
  if (type === OBJECT_TYPE.line) return n >= 2;
  if (type === OBJECT_TYPE.area) return n >= 3;
  if (isTextType(type)) return before === undefined || n === before;
  return n >= 1;
}

interface Geometry {
  coords: PatchCoord[];
}

/**
 * Applies `patch` to `doc` (map-patches §2). Pure and deterministic: the
 * result depends on the patch's content, not on the insertion order of its
 * records; `doc` is never mutated. Ops that cannot be applied are skipped
 * and listed in `issues`, never thrown. A null, disabled or op-less patch
 * returns `doc` itself. `doc` must be the pinned document the patch is
 * keyed onto (the caller pairs them by hash); applying ops to an effective
 * document throws.
 */
export function applyPatch(doc: MapDocument, patch: MapPatch | null | undefined): AppliedPatch {
  if (!patch || !patch.enabled) return { document: doc, issues: [] };
  const opIds = Object.keys(patch.ops).sort();
  if (opIds.length === 0) return { document: doc, issues: [] };
  // A programming error, not patch content: patches are applied to the pinned document only (map-patches §2).
  if ((doc as EffectiveDocument).patch) throw new Error("applyPatch: the document already has a patch applied");

  const n = doc.header.objects.count;
  const baseSymbols = doc.header.symbols.length;
  const issues: PatchIssue[] = [];
  const report = (opId: string, code: PatchIssueCode) => issues.push({ opId, code });

  // The combined symbol table: the document's, then every patch symbol in key order, as far as u16 reaches.
  const symbolKeys = Object.keys(patch.symbols).sort().slice(0, Math.max(0, SYMBOL_TABLE_MAX - baseSymbols));
  const patchSymbolIndex = new Map(symbolKeys.map((k, i) => [k, baseSymbols + i]));
  const symbols: DocumentSymbol[] = [...doc.header.symbols, ...symbolKeys.map((k) => patch.symbols[k])];

  /** The combined index of a reference whose symbol must be of `kind`, or an issue code. */
  const resolveSymbol = (ref: PatchSymbolRef, type: number): number | PatchIssueCode => {
    let idx: number | undefined;
    if ("doc" in ref) idx = ref.doc < baseSymbols ? ref.doc : undefined;
    else {
      idx = patchSymbolIndex.get(ref.patch);
      if (idx === undefined) return Object.hasOwn(patch.symbols, ref.patch) ? "symbol-table-full" : "symbol-missing";
    }
    if (idx === undefined) return "symbol-missing";
    return symbols[idx].kind === symbolKindOfType(type) ? idx : "kind-mismatch";
  };

  const bySource = new Map<number, number>();
  for (let i = 0; i < n; i++) bySource.set(doc.attrs.sourceIndex[i], i);

  const hidden = new Uint8Array(n);
  const symbolIdx = new Map<number, number>();
  const angle = new Map<number, number>();
  const geometry = new Map<number, Geometry>();
  const added: Extract<PatchOp, { op: "add" }>[] = [];
  const addedSymbol: number[] = [];

  for (const id of opIds) {
    const op = patch.ops[id];
    if (op.op === "add") {
      const s = resolveSymbol(op.symbol, op.type);
      if (typeof s === "string") report(id, s);
      else if (!geometryValid(op.type, op.coords.length)) report(id, "geometry-invalid");
      else {
        added.push(op);
        addedSymbol.push(s);
      }
      continue;
    }
    const i = bySource.get(op.sourceIndex);
    if (i === undefined) {
      report(id, "target-missing");
      continue;
    }
    const type = doc.attrs.type[i];
    if (op.op === "hide") hidden[i] = 1;
    else if (op.op === "resymbol") {
      const s = resolveSymbol(op.symbol, type);
      if (typeof s === "string") report(id, s);
      else symbolIdx.set(i, s);
    } else if (!geometryValid(type, op.coords.length, doc.attrs.coordCount[i])) report(id, "geometry-invalid");
    else {
      geometry.set(i, op);
      if (op.angle !== undefined) angle.set(i, op.angle);
    }
  }

  const m = added.length;
  const total = n + m;
  const attrs: ObjectAttrs = {
    symbolIdx: grow(doc.attrs.symbolIdx, total, Uint16Array),
    type: grow(doc.attrs.type, total, Uint8Array),
    angle: grow(doc.attrs.angle, total, Int16Array),
    stringIdx: grow(doc.attrs.stringIdx, total, Uint32Array),
    geomOffset: grow(doc.attrs.geomOffset, total, Uint32Array),
    coordCount: grow(doc.attrs.coordCount, total, Uint32Array),
    sourceIndex: grow(doc.attrs.sourceIndex, total, Uint32Array),
  };
  for (const [i, s] of symbolIdx) attrs.symbolIdx[i] = s;
  for (const [i, a] of angle) attrs.angle[i] = a;
  for (let k = 0; k < m; k++) {
    const op = added[k];
    attrs.symbolIdx[n + k] = addedSymbol[k];
    attrs.type[n + k] = op.type;
    attrs.angle[n + k] = op.angle ?? 0;
    attrs.sourceIndex[n + k] = ADDED_SOURCE_INDEX;
  }

  let { coords, flags, coordStart, bboxes } = doc;
  if (geometry.size > 0 || m > 0) {
    // Rebuild the coordinate arrays contiguous in object order.
    const geomOf = (i: number): Geometry | undefined => (i < n ? geometry.get(i) : added[i - n]);
    coordStart = new Uint32Array(total + 1);
    let size = 0;
    for (let i = 0; i < total; i++) {
      coordStart[i] = size;
      const g = geomOf(i);
      const count = g ? g.coords.length : doc.coordStart[i + 1] - doc.coordStart[i];
      attrs.coordCount[i] = count;
      size += count;
    }
    coordStart[total] = size;
    coords = new Int32Array(size * 2);
    flags = new Uint8Array(size);
    bboxes = new Int32Array(total * 4);
    for (let i = 0; i < total; i++) {
      const at = coordStart[i];
      const g = geomOf(i);
      if (!g) {
        const from = doc.coordStart[i], to = doc.coordStart[i + 1];
        coords.set(doc.coords.subarray(from * 2, to * 2), at * 2);
        flags.set(doc.flags.subarray(from, to), at);
        bboxes.set(doc.bboxes.subarray(i * 4, i * 4 + 4), i * 4);
        continue;
      }
      let minX = INT32_MAX, minY = INT32_MAX, maxX = INT32_MIN, maxY = INT32_MIN;
      g.coords.forEach((c, k) => {
        const [x, y] = c;
        coords[(at + k) * 2] = x;
        coords[(at + k) * 2 + 1] = y;
        flags[at + k] = c[2] ?? 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      });
      bboxes.set([minX, minY, maxX, maxY], i * 4);
    }
  }

  const header = { ...doc.header, symbols, objects: { ...doc.header.objects, count: total } };
  const text = (i: number) => (i < n ? doc.text(i) : undefined);
  const document: EffectiveDocument = {
    header,
    attrs,
    bboxes,
    coords,
    flags,
    coordStart,
    text,
    hidden: grow(hidden, total, Uint8Array),
    patch: { baseCount: n, baseSymbols, added: added.map((op) => op.id), symbols: symbolKeys },
  };
  return { document, issues };
}

type TypedArrayCtor<T> = { new (length: number): T };

/** A copy of `a` with room for `length` entries (zero-filled past `a`'s end). */
function grow<T extends { length: number; set(a: ArrayLike<number>): void }>(a: T, length: number, Ctor: TypedArrayCtor<T>): T {
  const out = new Ctor(length);
  out.set(a as unknown as ArrayLike<number>);
  return out;
}
