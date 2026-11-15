/**
 * Map mode's model (docs/course-editor.md §13; docs/map-patches.md §1–§2):
 * the pinned document with the event's patch over it, and the pure rules
 * that turn a gesture into one `PatchChange` and its inverse.
 *
 * Objects are named as the viewer's hit-test names them (`MapObjectRef`):
 * `{ source: sourceIndex }` for a document object, `{ added: id }` for one
 * the patch adds. The effective document here is built with the patch taken
 * as **enabled**: what an edit acts on, and what *Corrections* reports
 * issues for even while *Apply corrections* is off (§13 "Inspector").
 */

import { mapDocument, render, symbolLibrary } from "@oxygen/shared";
import type { MapObjectRef } from "../../../../map-gl/worker";
import type { SymbolGroup } from "../../../../lib/editor/symbol-groups";

type Pt = { x: number; y: number };
type PatchOp = mapDocument.PatchOp;
type PatchChange = mapDocument.PatchChange;

export type { MapObjectRef };

/** `source:<n>` / `added:<id>` — the `data-ref` of the inspector and the key of a selection. */
export const refKey = (ref: MapObjectRef): string => ("source" in ref ? `source:${ref.source}` : `added:${ref.added}`);
export const sameRef = (a: MapObjectRef | null | undefined, b: MapObjectRef | null | undefined): boolean =>
  !!a && !!b && refKey(a) === refKey(b);

export interface MapModel {
  hash: string;
  /** The pinned document the patch is keyed onto (the palette's and materialisation's input, §13 "Drawing"). */
  pinned: mapDocument.MapDocument;
  /** The effective document, the patch taken as enabled. */
  doc: mapDocument.EffectiveDocument;
  /** `applyPatch`'s issues (map-patches §2.3), op-id order. */
  issues: readonly mapDocument.PatchIssue[];
  unitsPerMm: number;
  /** The effective `objectIndex` of an object, null when the document has none. */
  indexOf(ref: MapObjectRef): number | null;
}

/** Builds the model of `bytes` with `patch` over it (a patch keyed onto another document is not applied). */
export function mapModelOf(hash: string, pinned: mapDocument.MapDocument, patch: mapDocument.MapPatch | null): MapModel {
  const p = patch && patch.documentHash === hash ? { ...patch, enabled: true } : null;
  const { document: doc, issues } = mapDocument.applyPatch(pinned, p);
  const n = doc.patch?.baseCount ?? doc.header.objects.count;
  const bySource = new Map<number, number>();
  for (let i = 0; i < n; i++) bySource.set(doc.attrs.sourceIndex[i], i);
  const byAdded = new Map((doc.patch?.added ?? []).map((id, k) => [id, n + k]));
  return {
    hash,
    pinned,
    doc,
    issues,
    unitsPerMm: doc.header.unitsPerMm,
    indexOf: (ref) => ("source" in ref ? bySource.get(ref.source) : byAdded.get(ref.added)) ?? null,
  };
}

const decoded = new Map<string, mapDocument.MapDocument>();
const models = new Map<string, MapModel>();

/** The model of a loaded document and the event's patch, kept per hash and patch version; decoded once per hash. */
export function mapModelFor(hash: string, bytes: ArrayBuffer, patch: { version: string; patch: mapDocument.MapPatch | null }): MapModel {
  const key = `${hash}:${patch.patch?.documentHash === hash ? patch.version : "0"}`;
  let model = models.get(key);
  if (!model) {
    let pinned = decoded.get(hash);
    if (!pinned) {
      pinned = mapDocument.decodeMapDocument(new Uint8Array(bytes));
      decoded.clear();
      decoded.set(hash, pinned);
    }
    model = mapModelOf(hash, pinned, patch.patch);
    models.clear();
    models.set(key, model);
  }
  return model;
}

/** The op id an object's state of `kind` has (map-patches §1.1). */
export const opIdOf = (kind: "hide" | "modify" | "resymbol", ref: { source: number }): string => `${kind}:${ref.source}`;

/** The object an op targets. */
export function refOfOp(op: PatchOp): MapObjectRef {
  return op.op === "add" ? { added: op.id } : { source: op.sourceIndex };
}

/** Whether the patch hides the object: a hide op for a document object (an added object is removed, not hidden). */
export function isHidden(patch: mapDocument.MapPatch | null, ref: MapObjectRef): boolean {
  return "source" in ref && !!patch?.ops[opIdOf("hide", ref)];
}

/** *Hide* (Delete): a hide op for a document object; an added object's add is removed (map-patches §1.1). */
export function hideChange(ref: MapObjectRef): PatchChange {
  return "source" in ref ? { put: [{ op: "hide", sourceIndex: ref.source }] } : { remove: [`add:${ref.added}`] };
}

/** *Restore*: the hide op removed. */
export function restoreChange(ref: { source: number }): PatchChange {
  return { remove: [opIdOf("hide", ref)] };
}

/** The object's effective coordinates (the patch's, else the document's), in document units with their flags. */
export function coordsOf(model: Pick<MapModel, "doc">, i: number): mapDocument.PatchCoord[] {
  return coordsIn(model.doc, i);
}

/** Object `i`'s coordinates in `doc` (pinned or effective), document units with their flags. */
export function coordsIn(doc: Pick<mapDocument.MapDocument, "coords" | "flags" | "coordStart">, i: number): mapDocument.PatchCoord[] {
  const { coords, flags, coordStart } = doc;
  const out: mapDocument.PatchCoord[] = [];
  for (let k = coordStart[i]; k < coordStart[i + 1]; k++) {
    const f = flags[k];
    out.push(f ? [coords[k * 2], coords[k * 2 + 1], f] : [coords[k * 2], coords[k * 2 + 1]]);
  }
  return out;
}

/**
 * The op a move by (`dxMm`, `dyMm`) puts (§13 "Ops"): every effective coordinate shifted by one integer delta, so
 * the shape moves rigidly; flags and the count kept; an existing `modify`'s angle kept. An added object's `add` is
 * rewritten. Null when the delta rounds to nothing or the object is not in the document.
 */
export function moveOp(model: MapModel, patch: mapDocument.MapPatch | null, ref: MapObjectRef, dxMm: number, dyMm: number): PatchOp | null {
  const dx = Math.round(dxMm * model.unitsPerMm), dy = Math.round(dyMm * model.unitsPerMm);
  if (dx === 0 && dy === 0) return null;
  const i = model.indexOf(ref);
  if (i === null) return null;
  const coords = coordsOf(model, i).map((c): mapDocument.PatchCoord => (c.length === 3 ? [c[0] + dx, c[1] + dy, c[2]] : [c[0] + dx, c[1] + dy]));
  return coordsOp(patch, ref, coords);
}

/**
 * The op that gives the object `coords` (a move, a node gesture): a document object's `modify` (an existing one's
 * angle kept), an added object's `add` rewritten. Null when an added object has no add in `patch`.
 */
export function coordsOp(patch: mapDocument.MapPatch | null, ref: MapObjectRef, coords: mapDocument.PatchCoord[]): PatchOp | null {
  if ("added" in ref) {
    const add = patch?.ops[`add:${ref.added}`];
    return add?.op === "add" ? { ...add, coords } : null;
  }
  const prev = patch?.ops[opIdOf("modify", ref)];
  const angle = prev?.op === "modify" ? prev.angle : undefined;
  return { op: "modify", sourceIndex: ref.source, coords, ...(angle !== undefined ? { angle } : {}) };
}

/**
 * The change that undoes `change` on `before` (§13; map-patches §1.5): every id it puts or removes goes back to its
 * state in `before` — put again when it was there, removed when it was not. Null when nothing would change.
 */
export function inverseChange(before: mapDocument.MapPatch | null, change: PatchChange): PatchChange | null {
  const put: PatchOp[] = [];
  const remove: string[] = [];
  const ids = [...(change.put ?? []).map((op) => mapDocument.patchOpId(op)), ...(change.remove ?? [])];
  for (const id of new Set(ids)) {
    const prev = before?.ops[id];
    if (prev) put.push(prev);
    else if (change.put?.some((op) => mapDocument.patchOpId(op) === id)) remove.push(id);
  }
  if (put.length === 0 && remove.length === 0) return null;
  return { ...(put.length ? { put } : {}), ...(remove.length ? { remove } : {}) };
}

/** Whether `change` changes `patch` at all (the same state again writes nothing, map-patches §3.2 step 5). */
export function changes(patch: mapDocument.MapPatch | null, change: PatchChange): boolean {
  for (const op of change.put ?? []) {
    if (JSON.stringify(patch?.ops[mapDocument.patchOpId(op)] ?? null) !== JSON.stringify(op)) return true;
  }
  return (change.remove ?? []).some((id) => !!patch?.ops[id]);
}

export interface MapObjectInfo {
  ref: MapObjectRef;
  type: number;
  /** The symbol's number (an applied match's library code, else the source code) and its name. */
  code: string;
  name: string;
  /** The symbol index in the effective table (`data-symbol`). */
  symbolIdx: number;
  /** The effective symbol as an op references it (`{ doc }` below the document's table, else `{ patch: key }`). */
  symbol: mapDocument.PatchSymbolRef;
  /** The angle, 0.1° (`attrs.angle`). */
  angle: number;
  /**
   * Drawn from the library's preview (an applied match; a patch symbol, of the entry its key names) or the document
   * symbol's; null without either.
   */
  swatch: SymbolGroup["swatch"];
  /** The object's box, paper mm. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** What the inspector's *Map object* section shows (§13 "Inspector"); null when the object is not in the document. */
export function objectInfo(model: MapModel, ref: MapObjectRef, lang: string): MapObjectInfo | null {
  const i = model.indexOf(ref);
  if (i === null) return null;
  const { doc } = model;
  const symbolIdx = doc.attrs.symbolIdx[i];
  const s = doc.header.symbols[symbolIdx];
  const baseSymbols = doc.patch?.baseSymbols ?? doc.header.symbols.length;
  const match = s && mapDocument.isAppliedMatch(s.match) ? s.match : null;
  const entry = match ? symbolLibrary.getLibraryEntry(match.canonicalId) : undefined;
  const sv = lang.toLowerCase().startsWith("sv");
  const u = model.unitsPerMm;
  const patchKey = symbolIdx >= baseSymbols ? doc.patch?.symbols[symbolIdx - baseSymbols] ?? null : null;
  const swatch: SymbolGroup["swatch"] = entry && match ? { kind: "library", canonicalId: match.canonicalId }
    : patchKey !== null ? (symbolLibrary.getLibraryEntry(patchKey) ? { kind: "library", canonicalId: patchKey } : null)
    : s?.render ? { kind: "document", idx: symbolIdx } : null;
  return {
    ref,
    type: doc.attrs.type[i],
    code: entry?.code ?? s?.code ?? "?",
    name: entry ? (sv && entry.name.sv ? entry.name.sv : entry.name.en) : s?.name ?? "",
    symbolIdx,
    symbol: patchKey !== null ? { patch: patchKey } : { doc: symbolIdx },
    angle: doc.attrs.angle[i],
    swatch,
    bounds: { minX: doc.bboxes[i * 4] / u, minY: doc.bboxes[i * 4 + 1] / u, maxX: doc.bboxes[i * 4 + 2] / u, maxY: doc.bboxes[i * 4 + 3] / u },
  };
}

/** The centre of an object's box, paper mm; null when it is not in the document. */
export function centreOf(model: MapModel, ref: MapObjectRef): Pt | null {
  const i = model.indexOf(ref);
  if (i === null) return null;
  const b = model.doc.bboxes, u = model.unitsPerMm;
  return { x: (b[i * 4] + b[i * 4 + 2]) / 2 / u, y: (b[i * 4 + 1] + b[i * 4 + 3]) / 2 / u };
}

const TEXT_TYPES = new Set<number>([mapDocument.OBJECT_TYPE.text, mapDocument.OBJECT_TYPE.formattedText, mapDocument.OBJECT_TYPE.lineText]);

/**
 * Whether `pt` (paper mm) is on the object's drawn shape within `toleranceMm` (the press that starts a move, §13):
 * the object alone symbolised on the main thread and hit-tested, as the eyedropper does (`symbol-pick.ts`); a text by
 * its stored box (no fonts here). A hidden object is not drawn and never pressed.
 */
export function hitsObject(model: MapModel, ref: MapObjectRef, pt: Pt, toleranceMm: number): boolean {
  const i = model.indexOf(ref);
  if (i === null || model.doc.hidden?.[i]) return false;
  const u = model.unitsPerMm, b = model.doc.bboxes;
  const x = pt.x * u, y = pt.y * u, r = toleranceMm * u;
  if (x < b[i * 4] - r || x > b[i * 4 + 2] + r || y < b[i * 4 + 1] - r || y > b[i * 4 + 3] + r) return false;
  if (TEXT_TYPES.has(model.doc.attrs.type[i])) return true;
  const input = mapDocument.documentRenderInput(model.doc, { only: [i] });
  const { stream } = render.symbolise({ objects: input.objects, symbols: input.symbols, fonts: [] });
  return render.hitTest(stream, pt.x * 1000, pt.y * 1000, { toleranceUm: toleranceMm * 1000 }).length > 0;
}

export interface CorrectionRow {
  opId: string;
  op: PatchOp["op"];
  ref: MapObjectRef;
  /** The object's symbol as `objectInfo` names it (`code name`), null when the target is missing. */
  label: string | null;
  issue: mapDocument.PatchIssueCode | null;
}

/** *Corrections* (§13 "Inspector"): every op of the patch in op-id order, with its object's symbol and any issue. */
export function correctionRows(model: MapModel | null, patch: mapDocument.MapPatch | null, lang: string): CorrectionRow[] {
  if (!patch) return [];
  const issues = new Map((model?.issues ?? []).map((x) => [x.opId, x.code]));
  return Object.keys(patch.ops).sort().map((opId) => {
    const op = patch.ops[opId];
    const ref = refOfOp(op);
    const info = model ? objectInfo(model, ref, lang) : null;
    return { opId, op: op.op, ref, label: info ? `${info.code} ${info.name}`.trim() : null, issue: issues.get(opId) ?? null };
  });
}

/**
 * The corrected objects in *Corrections* order, each once: what Tab steps through without a click stack (§13). A row
 * whose object is not in the document (`target-missing`) is skipped: it cannot be selected.
 */
export function correctedRefs(rows: readonly CorrectionRow[]): MapObjectRef[] {
  const seen = new Set<string>();
  const out: MapObjectRef[] = [];
  for (const r of rows) {
    if (r.label === null) continue;
    const k = refKey(r.ref);
    if (!seen.has(k)) { seen.add(k); out.push(r.ref); }
  }
  return out;
}

/** The next (`dir` 1) or previous entry of `list` after `current`, wrapping; the first (or last) when `current` is not in it. */
export function stepRef(list: readonly MapObjectRef[], current: MapObjectRef | null, dir: 1 | -1): MapObjectRef | null {
  if (list.length === 0) return null;
  const at = current ? list.findIndex((r) => sameRef(r, current)) : -1;
  if (at < 0) return dir > 0 ? list[0] : list[list.length - 1];
  return list[(at + dir + list.length) % list.length];
}

/**
 * Whether the canvas, showing patch version `drawn`, shows the write that answered `waitFor` (§13 "Committing"):
 * versions are the row's increasing token, so a later version drawn first (a quick next write, another editor's)
 * covers it too.
 */
export function drawnCovers(drawn: string | null, waitFor: string): boolean {
  if (drawn === null) return false;
  try {
    return BigInt(drawn) >= BigInt(waitFor);
  } catch {
    return drawn === waitFor;
  }
}
