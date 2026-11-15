/**
 * Map mode's nodes (docs/course-editor.md §13 "Nodes"; 08 §4.7, §5.3; row G7): a selected line's or area's
 * coordinates as editable rings of vertices in paper mm (`geometry-edit.ts` `ringsOfCoords`), and a ring's edit
 * back as the one op of the gesture (`coordsOp`: a `modify`, an added object's `add` rewritten).
 */

import { mapDocument } from "@oxygen/shared";
import { coordsOfRings, ringsOfCoords, type PathRing } from "../../../../lib/editor/geometry-edit";
import type { VertexRule } from "../../../../lib/editor/geometry-gestures";
import { snapIndexOf, type SnapIndex } from "../../../../lib/editor/snap";
import { coordsOf, coordsOp, type MapModel, type MapObjectRef } from "./model";

type PatchOp = mapDocument.PatchOp;

/** A selected object's nodes: its rings (the first the outline, then an area's holes) in paper mm. */
export interface NodePath {
  ref: MapObjectRef;
  area: boolean;
  rings: PathRing[];
}

/** At most this many nodes over an object's rings are edited (§13 "Nodes"; user 2026-11-15, G7 question 2). */
export const MAP_NODES_MAX = 2000;

/** Why the selected object shows no nodes (`editor-map-nodes-none` `data-reason`, §13 "Nodes"). */
export type NodesReason = "kind" | "hidden" | "encoding" | "too-many" | "read-only" | "disabled";

/**
 * The nodes of a line or area object, from `coords` when given (the draft's, so the handles follow a drag), else its
 * effective coordinates; or why there are none: a point or text (`kind`), hidden, a broken curve encoding
 * (`ringsOfCoords`), over `MAP_NODES_MAX`, no `courses.edit` (`read-only`), *Apply corrections* off (`disabled`).
 * Null for an object not in the document.
 */
export function nodesOf(
  model: MapModel, ref: MapObjectRef, o: { canEdit: boolean; correctionsOn: boolean; coords?: readonly mapDocument.PatchCoord[] | null },
): { path: NodePath } | { reason: NodesReason } | null {
  const i = model.indexOf(ref);
  if (i === null) return null;
  const type = model.doc.attrs.type[i];
  if (type !== mapDocument.OBJECT_TYPE.line && type !== mapDocument.OBJECT_TYPE.area) return { reason: "kind" };
  if (model.doc.hidden?.[i]) return { reason: "hidden" };
  if (!o.canEdit) return { reason: "read-only" };
  if (!o.correctionsOn) return { reason: "disabled" };
  const area = type === mapDocument.OBJECT_TYPE.area;
  const rings = ringsOfCoords(o.coords ?? coordsOf(model, i), model.unitsPerMm, area);
  if (!rings) return { reason: "encoding" };
  if (rings.reduce((n, r) => n + r.vertices.length, 0) > MAP_NODES_MAX) return { reason: "too-many" };
  return { path: { ref, area, rings } };
}

/** What a ring allows (`geometry-gestures.ts` `VertexRule`): any count down to 3 when closed, 2 when open; curves. */
export function ringRule(ring: Pick<PathRing, "closed">): VertexRule {
  return { min: ring.closed ? 3 : 2, max: Infinity, curves: true, closed: ring.closed };
}

/** The path with ring `r`'s vertices replaced. */
export function withRing(path: NodePath, r: number, vertices: PathRing["vertices"]): NodePath {
  return { ...path, rings: path.rings.map((ring, k) => (k === r ? { ...ring, vertices } : ring)) };
}

/**
 * The op a node gesture puts (§13 "Nodes"): every ring written back (`coordsOfRings`, whole units) as the object's
 * coordinates. Null when that is the object's coordinates already (a drag that rounds to nothing) or an added object
 * has no add.
 */
export function nodesOp(model: MapModel, patch: mapDocument.MapPatch | null, path: NodePath): PatchOp | null {
  const i = model.indexOf(path.ref);
  if (i === null) return null;
  const coords = coordsOfRings(path.rings, model.unitsPerMm);
  if (JSON.stringify(coords) === JSON.stringify(coordsOf(model, i))) return null;
  return coordsOp(patch, path.ref, coords);
}

/**
 * Node snapping's index (§13 "Nodes", "Snapping"): the effective document's candidates with the edited object left
 * out (masked as hidden), so a node never snaps to where it started or to its own neighbours. Null when the object is
 * not in the document.
 */
export function nodeSnapIndex(model: MapModel, ref: MapObjectRef): SnapIndex | null {
  const i = model.indexOf(ref);
  if (i === null) return null;
  const hidden = new Uint8Array(model.doc.attrs.symbolIdx.length);
  if (model.doc.hidden) hidden.set(model.doc.hidden.subarray(0, hidden.length));
  hidden[i] = 1;
  return snapIndexOf({ ...model.doc, hidden });
}
