/**
 * Map mode's line and area operations (docs/course-editor.md §13 "Line and area operations"; 08 §4.7; row G10):
 * *Reverse*, *Split at node* and *Join* on a line, *Cut hole* and *Remove hole* on an area — each the object's
 * coordinates rewritten (a `modify`, an added object's `add` rewritten, `model.ts` `coordsOp`), a join also hiding
 * (or removing) the picked line and a split also adding the second part. Pure: the inverse is `inverseChange`'s.
 *
 * Lines are edited on their raw coordinates (document units, every flag kept exactly); holes through the rings
 * (`geometry-edit.ts` `ringsOfCoords` / `coordsOfRings`). The flag rules (`map-document-format.md` §4; the
 * renderer's reading, `render/measure.ts` `pathSections` / `gapIntervals`, `render/symbolise.ts` borders):
 * - `bezierFirst` / `bezierSecond` mark a cubic's controls; reversed, the two controls swap roles.
 * - `corner`, `dash` and `gap` are read at their point: they stay on it.
 * - `noLeft` / `noRight` on an anchor cover the segment from it to the next anchor: reversed, they move to the
 *   segment's other end, left and right swapped; a control's own (zero-length) bits stay on it, swapped.
 * - `gap` points pair up in path order (a gap runs from one to the next; an unpaired last one is dropped, a last
 *   point closes an open one). Before an edit the flags are balanced (`balanceGaps`: a dangling opener and a last
 *   point that closes nothing lose the bit, which draws nothing either way), so a reverse, split or join keeps
 *   every gap where it was drawn.
 */

import { mapDocument, render } from "@oxygen/shared";
import { coordsOfRings, ringsOfCoords, type Vertex } from "../../../../lib/editor/geometry-edit";
import { SNAP_MM } from "../../../../lib/editor/snap";
import { coordsOf, coordsOp, objectInfo, sameRef, type MapModel, type MapObjectRef } from "./model";
import { MAP_NODES_MAX } from "./nodes";
import { addOp } from "./symbols";

type C = mapDocument.PatchCoord;
type PatchChange = mapDocument.PatchChange;

const F = render.COORD_FLAG;
const CURVE = F.bezierFirst | F.bezierSecond;
const SIDES = F.noLeft | F.noRight;

const flagsOf = (c: C): number => c[2] ?? 0;
const at = (x: number, y: number, f: number): C => (f ? [x, y, f] : [x, y]);
const withFlags = (c: C, f: number): C => at(c[0], c[1], f);
const isAnchor = (c: C): boolean => (flagsOf(c) & CURVE) === 0;
const swapSides = (f: number): number => (f & ~SIDES) | (f & F.noLeft ? F.noRight : 0) | (f & F.noRight ? F.noLeft : 0);
const anchorIndices = (coords: readonly C[]): number[] => coords.flatMap((c, k) => (isAnchor(c) ? [k] : []));
const dist = (a: C, b: C): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Why an operation does not apply (`data-reason` of its button, §13 "Line and area operations"). */
export type ShapeReason =
  | "kind" | "encoding" | "multi-part" | "closed" | "too-few" | "too-many" | "no-node" | "end-node" | "no-hole-node" | "not-line";

/** A raw path's parts: a `hole` flag on an anchor starts the next one (a multi-part line, an area's rings). */
function partsOf(coords: readonly C[]): C[][] {
  const out: C[][] = [];
  for (const c of coords) {
    if (out.length === 0 || (isAnchor(c) && flagsOf(c) & F.hole)) out.push([]);
    out[out.length - 1].push(c);
  }
  return out;
}

/**
 * The gap flags paired as the renderer pairs them (`gapIntervals`): a gap opened and never closed (the last point
 * not flagged) loses its opener, and a flagged last point with no gap open loses its bit. Drawing-neutral.
 */
export function balanceGaps(part: readonly C[]): C[] {
  const out = [...part];
  const anchors = anchorIndices(part);
  if (anchors.length === 0) return out;
  let open = false, opener = -1;
  for (const k of anchors.slice(0, -1)) {
    if (flagsOf(part[k]) & F.gap) {
      open = !open;
      if (open) opener = k;
    }
  }
  const last = anchors[anchors.length - 1];
  const lastGap = (flagsOf(part[last]) & F.gap) !== 0;
  if (open && !lastGap) out[opener] = withFlags(part[opener], flagsOf(part[opener]) & ~F.gap);
  if (!open && lastGap) out[last] = withFlags(part[last], flagsOf(part[last]) & ~F.gap);
  return out;
}

/** One part reversed (no hole bit handled here; the gaps balanced first). */
function reversePart(part: readonly C[]): C[] {
  const rev = balanceGaps(part).reverse();
  const anchors = anchorIndices(rev);
  const sidesOfNext = new Map<number, number>();
  // New anchor j covers the segment old anchor j+1 (in the reversed order) covered: its border bits, swapped.
  anchors.forEach((k, j) => sidesOfNext.set(k, j + 1 < anchors.length ? swapSides(flagsOf(rev[anchors[j + 1]]) & SIDES) : 0));
  return rev.map((c, k) => {
    const f = flagsOf(c);
    if (f & CURVE) {
      // The controls swap roles; their own bits stay, left and right swapped.
      const role = f & F.bezierFirst ? F.bezierSecond : F.bezierFirst;
      return withFlags(c, (swapSides(f & ~CURVE)) | role);
    }
    return withFlags(c, (f & ~SIDES) | (sidesOfNext.get(k) ?? 0));
  });
}

/**
 * A line's coordinates reversed (*Reverse*): every part on its own, in its place; the flags by the module's rules,
 * so the drawing stays the same with dash and glyph layout running from the new start.
 */
export function reverseCoords(coords: readonly C[]): C[] {
  return partsOf(coords).flatMap((part, r) => {
    const plain = part.map((c, k) => (k === 0 && r > 0 ? withFlags(c, flagsOf(c) & ~F.hole) : c));
    const rev = reversePart(plain);
    if (r > 0) rev[0] = withFlags(rev[0], flagsOf(rev[0]) | F.hole);
    return rev;
  });
}

/** Whether the gap is open just before anchor `k` (the anchors before it toggled it, `gapIntervals`). */
function gapOpenBefore(part: readonly C[], k: number): boolean {
  let open = false;
  for (const a of anchorIndices(part)) {
    if (a >= k) break;
    if (flagsOf(part[a]) & F.gap) open = !open;
  }
  return open;
}

/** An open path cut at its anchor `k` (a coordinate index): both parts have that node, every gap kept. */
function cutAt(part: readonly C[], k: number): { head: C[]; tail: C[] } {
  const p = balanceGaps(part);
  const before = gapOpenBefore(p, k);
  const own = flagsOf(p[k]);
  const after = before !== ((own & F.gap) !== 0);
  const head = p.slice(0, k + 1);
  const tail = p.slice(k);
  // The head's last point closes a gap open there; its border bits cover nothing now.
  head[k] = withFlags(p[k], (own & ~(SIDES | F.gap)) | (before ? F.gap : 0));
  // The tail's first point opens the gap that was open after the node.
  tail[0] = withFlags(p[k], (own & ~F.gap) | (after ? F.gap : 0));
  return { head, tail };
}

/**
 * Two open paths end to start: `p`'s last point and `q`'s first become one node at `pos` (the surviving line's
 * end), with `cornerDash` (the survivor's point's `corner` / `dash`), `q`'s first point's border bits (it starts the
 * next segment) and the gap toggles of both (an even pair cancels).
 */
function mergeEnds(p: readonly C[], q: readonly C[], pos: C, cornerDash: number): C[] {
  const a = flagsOf(p[p.length - 1]), b = flagsOf(q[0]);
  const gap = ((a ^ b) & F.gap);
  const node = at(pos[0], pos[1], (cornerDash & (F.corner | F.dash)) | (b & SIDES) | gap);
  return [...p.slice(0, -1), node, ...q.slice(1)];
}

/** Two open paths end to start, joined by a straight segment: `p`'s last point's border bits would cover it, cleared. */
function bridgeEnds(p: readonly C[], q: readonly C[]): C[] {
  const last = p[p.length - 1];
  return [...p.slice(0, -1), withFlags(last, flagsOf(last) & ~SIDES), ...q];
}

/** Ends within this many document units merge (`SNAP_MM`, inclusive). */
const mergeReach = (unitsPerMm: number) => SNAP_MM * unitsPerMm + 1e-9;

/**
 * Line `a` (the survivor) joined with line `b` at their nearest pair of ends (§13 "Line and area operations" 2–3):
 * `a`'s direction kept, `b` reversed where needed; ends within 0.5 mm become one node at `a`'s end, ends farther
 * apart are both kept with a straight segment between them. Both are open single-part lines. A tie prefers the
 * earlier pairing: `a`'s end to `b`'s start, `a`'s end to `b`'s end, `a`'s start to `b`'s end, `a`'s start to `b`'s
 * start.
 */
export function joinCoords(a: readonly C[], b: readonly C[], unitsPerMm: number): C[] {
  const A = balanceGaps(a), B = balanceGaps(b);
  const aS = A[0], aE = A[A.length - 1], bS = B[0], bE = B[B.length - 1];
  const options = [
    { d: dist(aE, bS), make: () => ({ p: A, q: B, survivorEnd: "p" as const }) },
    { d: dist(aE, bE), make: () => ({ p: A, q: reverseCoords(B), survivorEnd: "p" as const }) },
    { d: dist(aS, bE), make: () => ({ p: B, q: A, survivorEnd: "q" as const }) },
    { d: dist(aS, bS), make: () => ({ p: reverseCoords(B), q: A, survivorEnd: "q" as const }) },
  ];
  let best = options[0];
  for (const o of options) if (o.d < best.d) best = o;
  const { p, q, survivorEnd } = best.make();
  if (best.d > mergeReach(unitsPerMm)) return bridgeEnds(p, q);
  const end = survivorEnd === "p" ? p[p.length - 1] : q[0];
  return mergeEnds(p, q, end, flagsOf(end));
}

/**
 * An open single-part line closed into a loop (a *Join* pick on the line itself, §13 answer 1): its last point
 * moved onto its first when within 0.5 mm (it needs 4 nodes, so the loop reads closed), else a straight segment
 * from it back to the first point (3 nodes). Null with too few nodes.
 */
export function closeCoords(a: readonly C[], unitsPerMm: number): C[] | null {
  const A = balanceGaps(a);
  const n = anchorIndices(A).length;
  const first = A[0], last = A[A.length - 1];
  if (dist(first, last) <= mergeReach(unitsPerMm)) {
    if (n < 4) return null;
    return [...A.slice(0, -1), at(first[0], first[1], flagsOf(last))];
  }
  if (n < 3) return null;
  return bridgeEnds(A, [at(first[0], first[1], 0)]);
}

/**
 * Split result of a line at its node `node` (the ordinal of the nodes tool's ring): an open line in two at that node
 * (`head` from the start, `tail` to the end); a closed line opened there as one object (§13 answer 4) — its
 * coordinates rotated to start and end on the node, so it is still a loop with its start moved (`opened`). Null at
 * an end node (an open line's first or last, a closed line's first) or out of range.
 */
export function splitCoords(coords: readonly C[], node: number, closed: boolean): { head: C[]; tail: C[] } | { opened: C[] } | null {
  const anchors = anchorIndices(coords);
  const count = closed ? anchors.length - 1 : anchors.length;
  if (node <= 0 || node >= count - (closed ? 0 : 1)) return null;
  const k = anchors[node];
  const { head, tail } = cutAt(coords, k);
  if (!closed) return { head, tail };
  // The tail (node → the start again) then the head (start → node), the start a node of the path again: its own
  // flags, and the closing point's corner / dash.
  const first = head[0], closing = tail[tail.length - 1];
  return { opened: mergeEnds(tail, head, first, flagsOf(first) | flagsOf(closing)) };
}

// ─── The selection's shape and the operations' changes ──

/** A line's shape for the operations: its effective coordinates, whether it is a loop, its node count. */
export interface LineShape { coords: C[]; closed: boolean; nodes: number; parts: number }

/** The selected line's shape, or why the line operations do not apply (`kind`: not a line; `encoding`). */
export function lineShape(model: MapModel, ref: MapObjectRef): LineShape | { reason: ShapeReason } | null {
  const i = model.indexOf(ref);
  if (i === null) return null;
  if (model.doc.attrs.type[i] !== mapDocument.OBJECT_TYPE.line) return { reason: "kind" };
  const coords = coordsOf(model, i);
  const rings = ringsOfCoords(coords, model.unitsPerMm, false);
  if (!rings) return { reason: "encoding" };
  return { coords, closed: rings.length === 1 && rings[0].closed, nodes: rings.reduce((n, r) => n + r.vertices.length, 0), parts: rings.length };
}

/** The area's rings (§13 "Nodes"), or why the hole operations do not apply. */
export function areaRings(model: MapModel, ref: MapObjectRef): { coords: C[]; holes: number; nodes: number } | { reason: ShapeReason } | null {
  const i = model.indexOf(ref);
  if (i === null) return null;
  if (model.doc.attrs.type[i] !== mapDocument.OBJECT_TYPE.area) return { reason: "kind" };
  const coords = coordsOf(model, i);
  const rings = ringsOfCoords(coords, model.unitsPerMm, true);
  if (!rings) return { reason: "encoding" };
  return { coords, holes: rings.length - 1, nodes: rings.reduce((n, r) => n + r.vertices.length, 0) };
}

/** Whether the line operations that need one open single-part line (split's first part aside) refuse it. */
function singleLine(s: LineShape | { reason: ShapeReason } | null): LineShape | { reason: ShapeReason } {
  if (!s) return { reason: "kind" };
  if ("reason" in s) return s;
  if (s.parts > 1) return { reason: "multi-part" };
  return s;
}

type Built = { change: PatchChange } | { reason: ShapeReason };

/** *Reverse* (§13): one op, the coordinates reversed. Null when nothing changes (a one-point line). */
export function reverseChange(model: MapModel, patch: mapDocument.MapPatch | null, ref: MapObjectRef): Built | null {
  const s = lineShape(model, ref);
  if (!s) return null;
  if ("reason" in s) return s;
  const op = coordsOp(patch, ref, reverseCoords(s.coords));
  return op ? { change: { put: [op] } } : null;
}

/**
 * *Split at node* (§13 answer 4) at the focused node `node`: the part from the start to it stays the object, the
 * rest becomes a new added line `newId` with the object's effective symbol; a loop opens at the node as one object.
 */
export function splitChange(model: MapModel, patch: mapDocument.MapPatch | null, ref: MapObjectRef, node: number | null, newId: string): Built | null {
  const s = singleLine(lineShape(model, ref));
  if ("reason" in s) return s;
  if (node === null) return { reason: "no-node" };
  const r = splitCoords(s.coords, node, s.closed);
  if (!r) return { reason: "end-node" };
  if ("opened" in r) {
    const op = coordsOp(patch, ref, r.opened);
    return op ? { change: { put: [op] } } : null;
  }
  const info = objectInfo(model, ref, "en");
  const op = coordsOp(patch, ref, r.head);
  if (!op || !info) return null;
  return { change: { put: [op, addOp(newId, 2, info.symbol, r.tail)] } };
}

/** Whether a result of `after` nodes takes the handles from an object of `before` (§13 "Nodes", the 2000 cap). */
const overCap = (before: number, after: number) => before <= MAP_NODES_MAX && after > MAP_NODES_MAX;

/**
 * *Join* (§13 answers 1–3, 8): `survivor` (the selection) keeps its identity, symbol and direction with `picked`'s
 * nodes joined on; the picked line is hidden (a document object) or its add removed — two ops in one change. The
 * survivor picked again closes it into a loop.
 */
export function joinChange(model: MapModel, patch: mapDocument.MapPatch | null, survivor: MapObjectRef, picked: MapObjectRef): Built | null {
  const a = singleLine(lineShape(model, survivor));
  if ("reason" in a) return a;
  if (a.closed) return { reason: "closed" };
  const u = model.unitsPerMm;
  if (sameRef(survivor, picked)) {
    const closed = closeCoords(a.coords, u);
    if (!closed) return { reason: "too-few" };
    const op = coordsOp(patch, survivor, closed);
    return op ? { change: { put: [op] } } : null;
  }
  const raw = lineShape(model, picked);
  if (raw && "reason" in raw && raw.reason === "kind") return { reason: "not-line" };
  const b = singleLine(raw);
  if ("reason" in b) return b;
  if (b.closed) return { reason: "closed" };
  const joined = joinCoords(a.coords, b.coords, u);
  if (overCap(a.nodes, anchorIndices(joined).length)) return { reason: "too-many" };
  const op = coordsOp(patch, survivor, joined);
  if (!op) return null;
  return "source" in picked
    ? { change: { put: [op, { op: "hide", sourceIndex: picked.source }] } }
    : { change: { put: [op], remove: [`add:${picked.added}`] } };
}

/** *Cut hole* (§13 answers 5–6): the drawn ring (paper mm) added to the area as a hole, as drawn. */
export function cutHoleChange(model: MapModel, patch: mapDocument.MapPatch | null, ref: MapObjectRef, vertices: readonly Vertex[]): Built | null {
  const s = areaRings(model, ref);
  if (!s) return null;
  if ("reason" in s && s.reason === "kind") return s;
  if (vertices.length < 3) return { reason: "too-few" };
  const ring = coordsOfRings([{ vertices: [...vertices], closed: true, repeatsFirst: true }], model.unitsPerMm);
  ring[0] = withFlags(ring[0], flagsOf(ring[0]) | F.hole);
  // An area whose rings do not parse still takes a hole: its coordinates are kept as they are.
  const before = "reason" in s ? MAP_NODES_MAX + 1 : s.nodes;
  if (overCap(before, before + vertices.length)) return { reason: "too-many" };
  const coords = "reason" in s ? coordsOf(model, model.indexOf(ref)!) : s.coords;
  const op = coordsOp(patch, ref, [...coords, ...ring]);
  return op ? { change: { put: [op] } } : null;
}

/** *Remove hole* (§13 answer 5): the area without its hole `ring` (≥ 1, the nodes tool's ring of the focused node). */
export function removeHoleChange(model: MapModel, patch: mapDocument.MapPatch | null, ref: MapObjectRef, ring: number | null): Built | null {
  const s = areaRings(model, ref);
  if (!s) return null;
  if ("reason" in s) return s;
  if (ring === null || ring < 1 || ring > s.holes) return { reason: "no-hole-node" };
  const parts = partsOf(s.coords);
  const coords = parts.filter((_, r) => r !== ring).flat();
  const op = coordsOp(patch, ref, coords);
  return op ? { change: { put: [op] } } : null;
}
