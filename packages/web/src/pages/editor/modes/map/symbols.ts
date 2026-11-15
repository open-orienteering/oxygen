/**
 * Map mode's symbols (docs/course-editor.md §13 "Drawing", "Symbol picker"; map-patches.md §1.2–§1.3; row G9): the
 * symbol an op references — a document symbol `{ doc }` or a patch symbol `{ patch: key }`, a library entry
 * materialised for the pinned document on first use and put in the same change (`putSymbols`) — and the pure changes
 * of drawing, *Change symbol* and *Rotation*. No React here: G26's track conversion reuses `symbolPut` and `addChange`.
 */

import { mapDocument, symbolLibrary, type render } from "@oxygen/shared";
import { coordsIn, coordsOf, opIdOf, type MapModel, type MapObjectRef } from "./model";

type PatchOp = mapDocument.PatchOp;
type PatchChange = mapDocument.PatchChange;
type PatchSymbolRef = mapDocument.PatchSymbolRef;
type PatchSymbol = mapDocument.PatchSymbol;

/** A symbol reference as one string (`doc:<i>` / `patch:<key>`): the picker's item key and the remembered choice. */
export const symbolKey = (ref: PatchSymbolRef): string => ("doc" in ref ? `doc:${ref.doc}` : `patch:${ref.patch}`);

/** The reference a `symbolKey` names; null for anything else. */
export function refOfSymbolKey(key: string): PatchSymbolRef | null {
  if (key.startsWith("patch:") && key.length > 6) return { patch: key.slice(6) };
  const m = /^doc:(\d+)$/.exec(key);
  return m ? { doc: Number(m[1]) } : null;
}

/** What an op needs to reference a symbol: the ref, and the symbol to put when the patch does not hold it yet. */
export type SymbolPut =
  | { ok: true; ref: PatchSymbolRef; putSymbols?: Record<string, PatchSymbol> }
  | { ok: false; reason: "unknown-symbol" | "unknown-entry" }
  | { ok: false; reason: "missing-colours"; missing: string[] };

/**
 * The symbol `ref` on `pinned` with `patch` (map-patches §1.3): a document symbol as it is; a patch key the patch
 * holds as it is; any other key materialised (`materialiseSymbol`, deterministic, so the client's put is the
 * server's) and returned in `putSymbols` for the change that first references it.
 */
export function symbolPut(pinned: Pick<mapDocument.MapDocument, "header">, patch: mapDocument.MapPatch | null, ref: PatchSymbolRef): SymbolPut {
  if ("doc" in ref) return ref.doc >= 0 && ref.doc < pinned.header.symbols.length ? { ok: true, ref } : { ok: false, reason: "unknown-symbol" };
  if (patch && Object.hasOwn(patch.symbols, ref.patch)) return { ok: true, ref };
  const m = mapDocument.materialiseSymbol(pinned, ref.patch);
  if (!m.ok) return m.reason === "missing-colours" ? { ok: false, reason: m.reason, missing: m.missing } : { ok: false, reason: m.reason };
  return { ok: true, ref: { patch: m.key }, putSymbols: { [m.key]: m.symbol } };
}

/** `change` with the symbol `put` needs (nothing when the patch holds it). */
const withSymbols = (put: Extract<SymbolPut, { ok: true }>, change: PatchChange): PatchChange =>
  put.putSymbols ? { ...change, putSymbols: put.putSymbols } : change;

/** The object kind a symbol must have for an object type (§13 "Symbol picker"): point 1, line 2, area 3; else null. */
export function kindOfType(type: number): "point" | "line" | "area" | null {
  switch (type) {
    case mapDocument.OBJECT_TYPE.point: return "point";
    case mapDocument.OBJECT_TYPE.line: return "line";
    case mapDocument.OBJECT_TYPE.area: return "area";
    default: return null;
  }
}

/** What draws a symbol: an applied match's library entry, else its own render (the render bridge's rule). */
export function symbolRender(s: mapDocument.DocumentSymbol | undefined): render.RenderSymbol | null {
  if (!s) return null;
  const match = mapDocument.isAppliedMatch(s.match) ? s.match : null;
  const entry = match ? symbolLibrary.getLibraryEntry(match.canonicalId) : undefined;
  return entry?.render ?? s.render ?? null;
}

/** Whether an object's angle turns the symbol (`render/symbolise.ts`): a point, orientation `object`, a rotatable glyph. */
export function isOrientable(s: mapDocument.DocumentSymbol | undefined): boolean {
  const r = symbolRender(s);
  return r?.type === "point" && r.orientation === "object" && r.glyph.rotatable;
}

/** The angle a press-drag of (`dx`, `dy`) paper mm sets (§13 "Drawing"): counter-clockwise from +x, 0.1°, 0–3599. */
export function angleOfDrag(dx: number, dy: number): number {
  const a = Math.round((Math.atan2(dy, dx) * 1800) / Math.PI);
  return ((a % 3600) + 3600) % 3600;
}

/** An `add` op (map-patches §1.2): `angle` only when not 0. */
export function addOp(id: string, type: 1 | 2 | 3, symbol: PatchSymbolRef, coords: mapDocument.PatchCoord[], angle = 0): Extract<PatchOp, { op: "add" }> {
  return { op: "add", id, type, symbol, coords, ...(angle ? { angle } : {}) };
}

/** The change that draws `op`, with its symbol's first use. */
export const addChange = (put: Extract<SymbolPut, { ok: true }>, op: PatchOp): PatchChange => withSymbols(put, { put: [op] });

/** A lowercase UUIDv7 (`map-patches.md` §2.2 orders added objects by id, so by creation time). */
export function newAddId(now = Date.now(), random: (n: Uint8Array) => Uint8Array = (n) => crypto.getRandomValues(n)): string {
  const b = random(new Uint8Array(16));
  let t = now;
  for (let i = 5; i >= 0; i--) { b[i] = t % 256; t = Math.floor(t / 256); }
  b[6] = 0x70 | (b[6] & 0x0f);
  b[8] = 0x80 | (b[8] & 0x3f);
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The pinned document's index of a document object (base objects keep their index in the effective document). */
const pinnedIndex = (model: MapModel, ref: MapObjectRef): number | null => ("source" in ref ? model.indexOf(ref) : null);

/**
 * *Change symbol* (§13 "Ops"): a document object's `resymbol` — dropped when `put` is the object's own symbol —, an
 * added object's `add` rewritten. Null when `put` is the effective symbol already, or the object is not there.
 */
export function resymbolChange(model: MapModel, patch: mapDocument.MapPatch | null, ref: MapObjectRef, put: Extract<SymbolPut, { ok: true }>): PatchChange | null {
  const same = (a: PatchSymbolRef | undefined) => !!a && symbolKey(a) === symbolKey(put.ref);
  if ("added" in ref) {
    const add = patch?.ops[`add:${ref.added}`];
    if (add?.op !== "add" || same(add.symbol)) return null;
    return withSymbols(put, { put: [{ ...add, symbol: put.ref }] });
  }
  const i = pinnedIndex(model, ref);
  if (i === null) return null;
  const prev = patch?.ops[opIdOf("resymbol", ref)];
  const own: PatchSymbolRef = { doc: model.pinned.attrs.symbolIdx[i] };
  if (same(own)) return prev ? { remove: [opIdOf("resymbol", ref)] } : null;
  if (prev?.op === "resymbol" && same(prev.symbol)) return null;
  return withSymbols(put, { put: [{ op: "resymbol", sourceIndex: ref.source, symbol: put.ref }] });
}

/**
 * *Rotation* (§13 "Ops"): a document point's `modify` with its effective coordinates and `angle` (0.1°) — dropped when
 * that is the document's own shape and angle —, an added point's `add` rewritten (0 omitted). Null when the angle is
 * the object's already.
 */
export function angleChange(model: MapModel, patch: mapDocument.MapPatch | null, ref: MapObjectRef, angle: number): PatchChange | null {
  const i = model.indexOf(ref);
  if (i === null || model.doc.attrs.angle[i] === angle) return null;
  if ("added" in ref) {
    const add = patch?.ops[`add:${ref.added}`];
    if (add?.op !== "add") return null;
    const { angle: _old, ...rest } = add;
    return { put: [angle ? { ...rest, angle } : rest] };
  }
  const coords = coordsOf(model, i);
  if (angle === model.pinned.attrs.angle[i] && JSON.stringify(coords) === JSON.stringify(coordsIn(model.pinned, i))) {
    return patch?.ops[opIdOf("modify", ref)] ? { remove: [opIdOf("modify", ref)] } : null;
  }
  return { put: [{ op: "modify", sourceIndex: ref.source, coords, angle }] };
}
