/**
 * Map mode's drawing (docs/course-editor.md §13 "Drawing"; map-patches.md §1.2; row G9): a placed point or a finished
 * line or area (vertices in paper mm, `tools/polygon.ts`) as the `add` op's coordinates in document units. Pure.
 */

import { mapDocument } from "@oxygen/shared";
import { coordsOfRings, type Vertex } from "../../../../lib/editor/geometry-edit";
import { addOp } from "./symbols";

type Pt = { x: number; y: number };
export type DrawKind = "point" | "line" | "area";

/** The object type an `add` of `kind` has. */
export const TYPE_OF_KIND: Record<DrawKind, 1 | 2 | 3> = {
  point: mapDocument.OBJECT_TYPE.point as 1, line: mapDocument.OBJECT_TYPE.line as 2, area: mapDocument.OBJECT_TYPE.area as 3,
};

/** The nodes a line (2) or an area (3) needs before it is an object (`applyPatch`'s `geometry-invalid` below). */
export const minNodes = (kind: "line" | "area"): number => (kind === "line" ? 2 : 3);

/** A point's one coordinate, rounded to whole document units. */
export const pointCoords = (pt: Pt, unitsPerMm: number): mapDocument.PatchCoord[] => [[Math.round(pt.x * unitsPerMm), Math.round(pt.y * unitsPerMm)]];

/**
 * A drawn line's or area's coordinates (`coordsOfRings`, §13 "Nodes"): curves as Bézier pairs, an area's ring closed
 * with its first point repeated at the end.
 */
export const pathCoords = (vertices: readonly Vertex[], kind: "line" | "area", unitsPerMm: number): mapDocument.PatchCoord[] =>
  coordsOfRings([{ vertices: [...vertices], closed: kind === "area", repeatsFirst: kind === "area" }], unitsPerMm);

/** The `add` of a drawing: a point at `at` (with `angle`), or a line / area of `vertices`. Null below the minimum. */
export function drawOp(
  id: string, kind: DrawKind, symbol: mapDocument.PatchSymbolRef, unitsPerMm: number, geometry: { at: Pt; angle?: number } | { vertices: readonly Vertex[] },
): Extract<mapDocument.PatchOp, { op: "add" }> | null {
  if ("at" in geometry) return kind === "point" ? addOp(id, 1, symbol, pointCoords(geometry.at, unitsPerMm), geometry.angle ?? 0) : null;
  if (kind === "point" || geometry.vertices.length < minNodes(kind)) return null;
  return addOp(id, TYPE_OF_KIND[kind], symbol, pathCoords(geometry.vertices, kind, unitsPerMm));
}
