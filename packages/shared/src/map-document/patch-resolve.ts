/**
 * Re-resolution of a map patch when the event's pin moves
 * (docs/map-patches.md §4; row G11; research 02 §7, 06 §6, 08 §4.7).
 *
 * `resolvePatch` re-keys a patch from the document it is keyed onto to
 * another: on the same source by `sourceIndex`, exactly; on another
 * edition by position and symbol within a tolerance. What cannot follow
 * goes to the patch's `unresolved` record with anchors taken from the old
 * document, and is retried at every later re-key. `attachUnresolved` is
 * *Corrections*' fix: an entry's op put onto an object the user chose.
 *
 * Pure TypeScript; no Node APIs.
 */

import type { MapDocument } from "./codec.js";
import { materialiseSymbol } from "./materialise.js";
import {
  mergePatch,
  patchOpId,
  unresolvedKey,
  type MapPatch,
  type PatchChange,
  type PatchCoord,
  type PatchOp,
  type PatchSymbol,
  type PatchSymbolRef,
  type SymbolAnchor,
  type TargetAnchor,
  type UnresolvedOp,
  type UnresolvedReason,
} from "./patch.js";
import { isAppliedMatch } from "./render-bridge.js";

/** Slice G's split decision: the nearest object of the same symbol within 0.5 mm on paper (§4.2). */
export const RESOLVE_TOLERANCE_MM = 0.5;

export interface ResolveOptions {
  /** The hash of `to`: the re-keyed patch's `documentHash`. */
  toHash: string;
  /** Paper mm; default `RESOLVE_TOLERANCE_MM`. */
  toleranceMm?: number;
}

export interface ResolvedPatch {
  patch: MapPatch;
  /** Ops (and retried entries) now in `ops`. */
  resolved: number;
  /** Entries in `unresolved`. */
  unresolved: number;
}

// ---- anchors (§4.1) ----------------------------------------------------------

/** Document symbol `idx` as an anchor another document can find; undefined outside the table. */
export function symbolAnchor(doc: Pick<MapDocument, "header">, idx: number): SymbolAnchor | undefined {
  const s = doc.header.symbols[idx];
  if (!s) return undefined;
  const a: SymbolAnchor = { code: s.code, name: s.name, kind: s.kind, canonicalId: isAppliedMatch(s.match) ? s.match.canonicalId : null };
  if (s.sourceIndex !== undefined) a.sourceIndex = s.sourceIndex;
  return a;
}

/** Object `i` of `doc` as an anchor: its type, symbol and bounding box in paper mm (the document's own geometry). */
export function targetAnchor(doc: MapDocument, i: number): TargetAnchor | undefined {
  const symbol = symbolAnchor(doc, doc.attrs.symbolIdx[i]);
  if (!symbol) return undefined;
  const u = doc.header.unitsPerMm;
  const [minX, minY, maxX, maxY] = doc.bboxes.subarray(i * 4, i * 4 + 4);
  return { type: doc.attrs.type[i], symbol, centreMm: [(minX + maxX) / 2 / u, (minY + maxY) / 2 / u], sizeMm: [(maxX - minX) / u, (maxY - minY) / u] };
}

/** The same symbol (§4.2): the same kind and, when both have an applied match, the same canonical id; else the same source code. */
export function sameSymbol(a: SymbolAnchor, b: SymbolAnchor): boolean {
  if (a.kind !== b.kind) return false;
  if (a.canonicalId !== null && b.canonicalId !== null) return a.canonicalId === b.canonicalId;
  return a.code === b.code;
}

// ---- the target document's lookups -------------------------------------------

/** What resolution asks of the document it re-keys onto; built once per `resolvePatch`. */
class Target {
  readonly doc: MapDocument;
  readonly source: string;
  readonly tolerance: number;
  private bySource: Map<number, number> | undefined;
  private bySymbol: Map<number, number[]> | undefined;
  private anchors: (SymbolAnchor | undefined)[] | undefined;
  private materialised = new Map<string, PatchSymbol | null>();

  constructor(doc: MapDocument, toleranceMm: number) {
    this.doc = doc;
    this.source = doc.header.source.hash;
    this.tolerance = toleranceMm;
  }

  /** The object index with `sourceIndex`, if any. */
  objectOfSource(sourceIndex: number): number | undefined {
    if (!this.bySource) {
      this.bySource = new Map();
      const s = this.doc.attrs.sourceIndex;
      for (let i = 0; i < this.doc.header.objects.count; i++) this.bySource.set(s[i], i);
    }
    return this.bySource.get(sourceIndex);
  }

  private symbolAnchors(): (SymbolAnchor | undefined)[] {
    return (this.anchors ??= this.doc.header.symbols.map((_, i) => symbolAnchor(this.doc, i)));
  }

  /** `{ doc }` index of the symbol that is `anchor`'s (§4.2 step 2), or undefined. */
  symbolOf(anchor: SymbolAnchor, sameSource: boolean): number | undefined {
    const table = this.symbolAnchors();
    if (sameSource) {
      const at = table.findIndex((s) => !!s && s.kind === anchor.kind && (anchor.sourceIndex !== undefined ? s.sourceIndex === anchor.sourceIndex : s.sourceIndex === undefined && s.code === anchor.code));
      return at < 0 ? undefined : at;
    }
    const at = table.findIndex((s) => !!s && sameSymbol(s, anchor));
    return at < 0 ? undefined : at;
  }

  /** The nearest object of the anchor's type and symbol within the tolerance (§4.2 step 1), or undefined. */
  objectNear(anchor: TargetAnchor): number | undefined {
    if (!this.bySymbol) {
      this.bySymbol = new Map();
      const s = this.doc.attrs.symbolIdx;
      for (let i = 0; i < this.doc.header.objects.count; i++) {
        const list = this.bySymbol.get(s[i]);
        if (list) list.push(i);
        else this.bySymbol.set(s[i], [i]);
      }
    }
    const table = this.symbolAnchors();
    const u = this.doc.header.unitsPerMm;
    const tol = this.tolerance;
    let best: number | undefined;
    let bestD = Infinity;
    let bestSource = Infinity;
    for (const [symbolIdx, objects] of this.bySymbol) {
      const s = table[symbolIdx];
      if (!s || !sameSymbol(s, anchor.symbol)) continue;
      for (const i of objects) {
        if (this.doc.attrs.type[i] !== anchor.type) continue;
        const [minX, minY, maxX, maxY] = this.doc.bboxes.subarray(i * 4, i * 4 + 4);
        if (Math.abs((maxX - minX) / u - anchor.sizeMm[0]) > tol || Math.abs((maxY - minY) / u - anchor.sizeMm[1]) > tol) continue;
        const d = Math.hypot((minX + maxX) / 2 / u - anchor.centreMm[0], (minY + maxY) / 2 / u - anchor.centreMm[1]);
        if (d > tol) continue;
        const src = this.doc.attrs.sourceIndex[i];
        if (d < bestD || (d === bestD && src < bestSource)) {
          best = i;
          bestD = d;
          bestSource = src;
        }
      }
    }
    return best;
  }

  /** The patch symbol `key` materialised for this document (§4.2 step 4), or null when it is not materialisable. */
  patchSymbol(key: string): PatchSymbol | null {
    let s = this.materialised.get(key);
    if (s === undefined) {
      const r = materialiseSymbol(this.doc, key);
      s = r.ok ? r.symbol : null;
      this.materialised.set(key, s);
    }
    return s;
  }
}

// ---- one op -----------------------------------------------------------------

/** An op detached from its origin: the op as keyed there and what finds it again (an `UnresolvedOp` without its reason). */
type Detached = Omit<UnresolvedOp, "reason">;

/** A live op of `from`, detached with anchors taken from `from` (§4.1). */
function detach(from: MapDocument, fromHash: string, op: PatchOp, objectOfSource: (s: number) => number | undefined): Detached {
  const d: Detached = { op, from: fromHash, fromSource: from.header.source.hash, unitsPerMm: from.header.unitsPerMm };
  if (op.op !== "add") {
    const i = objectOfSource(op.sourceIndex);
    const target = i === undefined ? undefined : targetAnchor(from, i);
    if (target) d.target = target;
  }
  if ((op.op === "resymbol" || op.op === "add") && "doc" in op.symbol) {
    const symbol = symbolAnchor(from, op.symbol.doc);
    if (symbol) d.symbol = symbol;
  }
  return d;
}

const rescale = (coords: PatchCoord[], k: number): PatchCoord[] =>
  k === 1 ? coords : coords.map((c) => {
    const x = Math.round(c[0] * k), y = Math.round(c[1] * k);
    return c.length === 3 ? [x, y, c[2]] : [x, y];
  });

type Outcome = { ok: true; op: PatchOp; symbolKey?: string } | { ok: false; reason: UnresolvedReason };

/** The symbol reference of a detached op on `to`, or a failure. */
function resolveSymbolRef(d: Detached, ref: PatchSymbolRef, to: Target): { ref: PatchSymbolRef; key?: string } | null {
  if ("patch" in ref) return to.patchSymbol(ref.patch) ? { ref, key: ref.patch } : null;
  if (!d.symbol) return null;
  const idx = to.symbolOf(d.symbol, d.fromSource === to.source);
  return idx === undefined ? null : { ref: { doc: idx } };
}

/**
 * A detached op on `to`, its target forced to `forceSource` when given (attach), else found as §4.2 says:
 * on the origin's source by `sourceIndex`, on another edition by the target anchor.
 */
function resolveDetached(d: Detached, to: Target, forceSource?: number): Outcome {
  const { op } = d;
  const k = to.doc.header.unitsPerMm / d.unitsPerMm;
  if (op.op === "add") {
    const s = resolveSymbolRef(d, op.symbol, to);
    if (!s) return { ok: false, reason: "symbol" };
    const out: PatchOp = { ...op, symbol: s.ref, coords: rescale(op.coords, k) };
    return { ok: true, op: out, symbolKey: s.key };
  }
  let i: number | undefined;
  if (forceSource !== undefined) i = to.objectOfSource(forceSource);
  else if (d.fromSource === to.source) i = to.objectOfSource(op.sourceIndex);
  else if (d.target) i = to.objectNear(d.target);
  if (i === undefined) return { ok: false, reason: "target" };
  const sourceIndex = to.doc.attrs.sourceIndex[i];
  if (op.op === "hide") return { ok: true, op: { op: "hide", sourceIndex } };
  if (op.op === "modify") return { ok: true, op: { ...op, sourceIndex, coords: rescale(op.coords, k) } };
  const s = resolveSymbolRef(d, op.symbol, to);
  if (!s) return { ok: false, reason: "symbol" };
  return { ok: true, op: { op: "resymbol", sourceIndex, symbol: s.ref }, symbolKey: s.key };
}

// ---- resolvePatch (§4.2–4.3) ----------------------------------------------------

/**
 * `patch` (keyed onto `from`) re-keyed onto `to` (map-patches §4.2): ops in
 * op-id order, then the unresolved entries in key order, each found on
 * `to` or kept unresolved; patch symbols materialised for `to`. Pure and
 * deterministic; never throws on patch content. `toHash ===
 * patch.documentHash` returns the patch itself.
 */
export function resolvePatch(from: MapDocument, to: MapDocument, patch: MapPatch, opts: ResolveOptions): ResolvedPatch {
  const before = Object.keys(patch.unresolved ?? {}).length;
  if (opts.toHash === patch.documentHash) return { patch, resolved: Object.keys(patch.ops).length, unresolved: before };
  const target = new Target(to, opts.toleranceMm ?? RESOLVE_TOLERANCE_MM);
  const fromSource = new Map<number, number>();
  for (let i = 0; i < from.header.objects.count; i++) fromSource.set(from.attrs.sourceIndex[i], i);

  const ops = new Map<string, PatchOp>();
  const unresolved = new Map<string, UnresolvedOp>();
  const usedSymbols = new Set<string>();

  const place = (d: Detached, keep?: UnresolvedOp): void => {
    const r = resolveDetached(d, target);
    if (r.ok && !ops.has(patchOpId(r.op))) {
      ops.set(patchOpId(r.op), r.op);
      if (r.symbolKey) usedSymbols.add(r.symbolKey);
      return;
    }
    // An entry that fails again is kept exactly as it was (§4.3); a new one gets its reason (a taken id is `target`).
    // On a key both hold (the pin left the entry's origin again), the op that was live wins: it is the later state.
    const entry: UnresolvedOp = keep ?? { ...d, reason: r.ok ? "target" : r.reason };
    const key = unresolvedKey(entry.from, entry.op);
    if (keep && unresolved.has(key)) return;
    unresolved.set(key, entry);
  };

  for (const id of Object.keys(patch.ops).sort()) place(detach(from, patch.documentHash, patch.ops[id], (s) => fromSource.get(s)));
  const pending = patch.unresolved ?? {};
  for (const key of Object.keys(pending).sort()) {
    const { reason: _r, ...d } = pending[key];
    void _r;
    place(d, pending[key]);
  }

  // Every patch symbol materialised again for `to`; those that no longer are, dropped (§4.2 step 4).
  const symbols = new Map<string, PatchSymbol>();
  for (const key of new Set([...Object.keys(patch.symbols), ...usedSymbols])) {
    const s = target.patchSymbol(key);
    if (s) symbols.set(key, s);
  }

  const next = mergePatch(
    { documentHash: opts.toHash, enabled: patch.enabled, ops: Object.fromEntries(ops), symbols: Object.fromEntries(symbols), unresolved: Object.fromEntries(unresolved) },
    {},
  );
  return { patch: next, resolved: ops.size, unresolved: unresolved.size };
}

// ---- attach (§4.3) -------------------------------------------------------------

export type AttachRefusal = "no-entry" | "drop-only" | "no-object" | "type-mismatch" | "symbol";

/**
 * *Corrections*' fix (§4.3): the change that puts unresolved entry `key`'s
 * op onto the object of `doc` (the patch's document) with `sourceIndex`, and
 * drops the entry. A `modify` keeps its coordinates (rescaled). Refused for
 * an add or a `symbol` entry (drop only), an object that does not exist,
 * a modify or resymbol onto another type, a symbol `doc` lacks.
 */
export function attachUnresolved(patch: MapPatch, key: string, doc: MapDocument, sourceIndex: number): { ok: true; change: PatchChange } | { ok: false; reason: AttachRefusal } {
  const entry = patch.unresolved?.[key];
  if (!entry) return { ok: false, reason: "no-entry" };
  if (entry.reason !== "target" || entry.op.op === "add") return { ok: false, reason: "drop-only" };
  const target = new Target(doc, RESOLVE_TOLERANCE_MM);
  const i = target.objectOfSource(sourceIndex);
  if (i === undefined) return { ok: false, reason: "no-object" };
  if (entry.op.op !== "hide" && entry.target && doc.attrs.type[i] !== entry.target.type) return { ok: false, reason: "type-mismatch" };
  const { reason: _r, ...d } = entry;
  void _r;
  const r = resolveDetached(d, target, sourceIndex);
  if (!r.ok) return { ok: false, reason: r.reason === "symbol" ? "symbol" : "no-object" };
  const change: PatchChange = { put: [r.op], removeUnresolved: [key] };
  if (r.symbolKey && !Object.hasOwn(patch.symbols, r.symbolKey)) change.putSymbols = { [r.symbolKey]: target.patchSymbol(r.symbolKey)! };
  return { ok: true, change };
}
