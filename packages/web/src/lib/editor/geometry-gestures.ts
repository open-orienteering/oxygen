/**
 * The geometry gestures on a selected path (docs/course-editor.md §7
 * "Editing geometry"; D5b), shared by the course editor's `V`
 * (`selectBinding`) and Layout mode's paths (`layoutBinding`, D16,
 * docs/course-layout.md §3): the pressing order vertex → handle grip →
 * edge / body, a vertex drag (Alt or not), a grip drag (a mirrored or smooth
 * pair kept, Alt live breaks it), Alt-click that toggles a vertex corner /
 * smooth, a click that focuses a vertex, a double-click on an edge that
 * inserts a smooth vertex (Alt: a corner) — and the shapes of the selected
 * path. One convention for every vertex tool (F18: smooth by default, Alt
 * sharp; F16's leg bends reuse it).
 *
 * Everything is in the path's own space ("model" units: paper mm for a
 * course object, page mm for a Layout path); the caller converts the
 * pointer and the reach into it, and the shapes out of it. Edits go
 * through `geometry-edit.ts`. Pure, but a drag in progress is the caller's
 * object, updated in place by `dragGeometry` (the bindings keep it in a
 * gesture ref).
 */

import type { ToolShape } from "../../components/MapViewer";
import {
  constrain45, dragGrip, insertVertex, nearestEdge, outlinePoints, retractHandles, smoothHandles, toggleSmooth, type Vertex,
} from "./geometry-edit";

type Pt = { x: number; y: number };

/** What a kind's path allows (`vertexRule`). */
export interface VertexRule { min: number; max: number; curves: boolean; closed: boolean }

/**
 * A drag on the selected path. `base` is the geometry at pointer-down: every drag event applies the whole from→to
 * offset to it, never to a draft. `vertex` null drags the whole path; `alt` on a vertex is the press's: a click with it
 * toggles the vertex (`toggleSmooth`), a drag moves it as without. A `grip` is a Bézier handle of vertex `index` dragged by the pointer's offset; its `alt` is
 * live (it breaks the pair).
 */
export type GeometryDrag =
  | { kind: "object"; from: Pt; to: Pt; moved: boolean; vertex: number | null; base: readonly Vertex[]; alt?: boolean; shift?: boolean }
  | { kind: "grip"; index: number; which: "in" | "out"; from: Pt; to: Pt; moved: boolean; base: readonly Vertex[]; alt: boolean; shift: boolean };

/** What a release does: write the geometry, drop the drag's draft, or (a click) focus a vertex / none. */
export type GeometryRelease =
  | { kind: "commit"; geometry: Vertex[] }
  | { kind: "cancel" }
  | { kind: "focus"; index: number | null }
  | null;

const PURPLE = "#7c3aed";
const BLUE = "#2563eb";

const near = (a: Pt, b: Pt, d: number) => Math.hypot(a.x - b.x, a.y - b.y) <= d;

/** Where a vertex's handle grips are. */
export const gripsOf = (v: Vertex): { which: "in" | "out"; at: Pt }[] => [
  ...(v.hIn ? [{ which: "in" as const, at: { x: v.x + v.hIn.x, y: v.y + v.hIn.y } }] : []),
  ...(v.hOut ? [{ which: "out" as const, at: { x: v.x + v.hOut.x, y: v.y + v.hOut.y } }] : []),
];

/** The test ids of a path's shapes. */
export interface GeometryShapeIds { outline: string; handle: string; grip: string }

/** A handle per vertex (`focused` drawn active, `data-focused`) and a grip per Bézier handle. */
export function geometryHandles(g: readonly Vertex[], focused: number | null, ids: GeometryShapeIds): ToolShape[] {
  const out: ToolShape[] = [];
  g.forEach((v, i) => {
    out.push({ kind: "handle", x: v.x, y: v.y, active: i === focused, testId: ids.handle, data: { index: String(i), ...(i === focused ? { focused: "true" } : {}) } });
    for (const q of gripsOf(v)) out.push({ kind: "grip", x: q.at.x, y: q.at.y, from: v, testId: ids.grip, data: { index: String(i), which: q.which } });
  });
  return out;
}

/**
 * A path's outline (each curve sampled), solid blue when selected, dashed purple otherwise; selected, its handles and
 * grips. `g` in the space the shapes are drawn in (the viewer's paper mm).
 */
export function geometryShapes(
  g: readonly Vertex[], closed: boolean, o: { selected: boolean; focused?: number | null; ids: GeometryShapeIds; data?: Record<string, string> },
): ToolShape[] {
  const ring = outlinePoints(g, closed);
  const out: ToolShape[] = [];
  if (ring.length >= 2) {
    out.push({
      kind: "line", points: ring, closed, dashed: !o.selected, color: o.selected ? BLUE : PURPLE, widthPx: o.selected ? 2 : 1.2,
      testId: o.ids.outline, ...(o.data ? { data: o.data } : {}),
    });
  }
  if (o.selected) out.push(...geometryHandles(g, o.focused ?? null, o.ids));
  return out;
}

/**
 * A press on the selected path, in pressing order: a vertex within `reach` (Alt kept for the release), a handle grip, then the edge within `reach` or the body (`onBody`: the caller's hit-test answered
 * this path) — the whole path. Null: not on the path; a closed area's inside is not its body (§5), so the viewer
 * pans.
 */
export function pressGeometry(
  g: readonly Vertex[], rule: VertexRule, p: { pt: Pt; reach: number; alt?: boolean; shift: boolean }, onBody: boolean,
): GeometryDrag | null {
  const vertex = g.findIndex((v) => near(v, p.pt, p.reach));
  if (vertex >= 0) return { kind: "object", from: p.pt, to: p.pt, moved: false, vertex, base: g, alt: !!p.alt };
  for (const [index, v] of g.entries()) {
    const grip = gripsOf(v).find((q) => near(q.at, p.pt, p.reach));
    if (grip) return { kind: "grip", index, which: grip.which, from: p.pt, to: p.pt, moved: false, base: g, alt: !!p.alt, shift: p.shift };
  }
  // Within reach of the edge, the press must not deselect: a double-click there inserts a vertex.
  const edge = g.length > 1 ? nearestEdge(g, rule.closed, p.pt) : null;
  if (onBody || (edge && edge.dist <= p.reach)) return { kind: "object", from: p.pt, to: p.pt, moved: false, vertex: null, base: g };
  return null;
}

/** The geometry a drag makes now. */
export function draggedGeometry(d: GeometryDrag): Vertex[] {
  const dx = d.to.x - d.from.x, dy = d.to.y - d.from.y;
  if (d.kind === "grip") {
    const v = d.base[d.index];
    const h = (d.which === "out" ? v.hOut : v.hIn) ?? { x: 0, y: 0 };
    const vec = { x: h.x + dx, y: h.y + dy };
    return dragGrip(d.base, d.index, d.which, d.shift ? constrain45(vec) : vec, d.alt);
  }
  if (d.vertex === null) return d.base.map((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  return d.base.map((v, i) => (i === d.vertex ? { ...v, x: v.x + dx, y: v.y + dy } : v));
}

/**
 * A drag event: the drag's end at `pt` with the keys held now (Shift; a grip's Alt), updated in place. The geometry
 * it makes, or null until the pointer has moved.
 */
export function dragGeometry(d: GeometryDrag, pt: Pt, mods?: { shift: boolean; alt: boolean }): Vertex[] | null {
  d.to = pt;
  d.moved = d.moved || !near(d.from, pt, 0.05);
  if (d.kind === "object") d.shift = mods?.shift ?? false;
  else {
    d.alt = mods?.alt ?? d.alt;
    d.shift = mods?.shift ?? d.shift;
  }
  return d.moved ? draggedGeometry(d) : null;
}

/**
 * The release at `pt` (null: cancelled). A drag commits, a cancelled one drops its draft; a click on a vertex
 * focuses it — with Alt it toggles corner / smooth instead (`toggleSmooth`; nothing for kinds without curves or an
 * open end) — and on the body unfocuses. A kind with a fixed vertex
 * count (a text's anchor, an image's corners) focuses nothing: `Delete` deletes the object. A click on a grip does
 * nothing.
 */
export function releaseGeometry(d: GeometryDrag, pt: Pt | null, rule: VertexRule): GeometryRelease {
  if (pt) d.to = pt;
  if (pt && d.moved) return { kind: "commit", geometry: draggedGeometry(d) };
  // Only a drag drew a draft; a click leaves the page's (the last write, until the list catches up) alone.
  if (d.moved) return { kind: "cancel" };
  if (!pt || d.kind === "grip") return null;
  if (d.vertex !== null && d.alt) {
    const toggled = rule.curves ? toggleSmooth(d.base, d.vertex, rule.closed) : null;
    return toggled ? { kind: "commit", geometry: toggled } : null;
  }
  return { kind: "focus", index: Number.isFinite(rule.max) ? null : d.vertex };
}

/**
 * A double-click on the path's edge within `reach`, off its vertices, for kinds without a vertex limit: the path
 * with a vertex there and the new vertex's index, to focus. The new vertex is smooth (F18): on a straight edge its
 * handles come from its neighbours (`smoothHandles`, collinear, so the shape stays until it moves), on a curve the
 * split keeps the shape. `alt` (or a kind without curves) inserts a corner — on a curve the split's handles of the
 * new vertex dropped, its neighbours' kept.
 */
export function insertAtEdge(
  g: readonly Vertex[], rule: VertexRule, pt: Pt, reach: number, alt = false,
): { geometry: Vertex[]; index: number } | null {
  if (rule.max !== Infinity) return null;
  const edge = g.some((v) => near(v, pt, reach)) ? null : nearestEdge(g, rule.closed, pt);
  if (!edge || edge.dist > reach) return null;
  const index = edge.index + 1;
  const split = insertVertex(g, rule.closed, edge.index, edge.t);
  if (alt || !rule.curves) return { geometry: retractHandles(split, index), index };
  return { geometry: split[index].hIn || split[index].hOut ? split : smoothHandles(split, index, rule.closed), index };
}
