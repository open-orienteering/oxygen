/**
 * The viewer bindings of the editor's tools (docs/course-editor.md §6, §7):
 * what each tool does with the pointer and what it draws on the UI layer.
 * The page builds one per render from its state; a gesture in progress
 * lives in `gesture` (a ref the page owns), so a re-render mid-drag keeps
 * it. Writes go out through the callbacks.
 */

import type { course } from "@oxygen/shared";
import type { EditorToolBinding, ToolPointer, ToolShape } from "../../../components/MapViewer";
import type { EditorTarget } from "../../../lib/editor/hit";
import { circleGapAt, circleGapFromDrag, compassDeg, legFraction, legGapAt, legGapFromDrag, type AngularGap, type FractionGap } from "./gaps";
import { isClosedKind, pointInPolygon, step, type PolygonState } from "./polygon";

type Pt = { x: number; y: number };

/** Handles grab within this many CSS px. */
export const HANDLE_PX = 7;

export type Gesture =
  | { kind: "lasso"; points: Pt[] }
  | { kind: "shift-click"; id: number }
  | { kind: "object"; id: number; from: Pt; to: Pt; moved: boolean; vertex: number | null }
  | { kind: "poly-vertex"; index: number }
  | { kind: "gap"; from: Pt; to: Pt }
  | null;

export interface GestureRef { current: Gesture }

/** Re-render the page: a gesture in `GestureRef` changed what the tool draws. */
export type Redraw = () => void;

const PURPLE = "#7c3aed";
const BLUE = "#2563eb";

const near = (a: Pt, b: Pt, mm: number) => Math.hypot(a.x - b.x, a.y - b.y) <= mm;
const translate = (g: readonly course.CourseObject["geometry"][number][], dx: number, dy: number) =>
  g.map((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));

/** A ring of a course object as the UI layer outlines it (its vertices, Bézier handles ignored). */
export const objectRing = (o: Pick<course.CourseObject, "geometry">): Pt[] => o.geometry.map((v) => ({ x: v.x, y: v.y }));

/** Outline shapes of an object (selection, or the outline of a kind the layer does not draw on screen). */
export function objectOutline(o: course.CourseObject, selected: boolean): ToolShape[] {
  const ring = objectRing(o);
  const closed = o.kind !== "oob_line" && o.kind !== "marked_route" && o.kind !== "text" && o.kind !== "image";
  const out: ToolShape[] = [];
  if (o.kind === "text") {
    out.push({ kind: "circle", x: ring[0].x, y: ring[0].y, rMm: 0.6, color: selected ? BLUE : PURPLE, testId: "editor-object-outline", data: { "object-id": String(o.id) } });
  } else if (ring.length >= 2) {
    out.push({
      kind: "line", points: ring, closed, dashed: !selected, color: selected ? BLUE : PURPLE, widthPx: selected ? 2 : 1.2,
      testId: "editor-object-outline", data: { "object-id": String(o.id), "object-kind": o.kind },
    });
  }
  if (selected) ring.forEach((v, i) => out.push({ kind: "handle", x: v.x, y: v.y, testId: "editor-object-handle", data: { index: String(i) } }));
  return out;
}

// ─── V: select / move, Shift-click, lasso, objects, double-click leg ──

export interface SelectOptions {
  gesture: GestureRef;
  /** The selected object, if any (handles and body drag). */
  selected: course.CourseObject | null;
  objects: readonly course.CourseObject[];
  /** Positioned sites by id (the lasso). */
  sites: readonly { id: number; x: number; y: number; kind: "control" | "start" | "finish" }[];
  multi: readonly number[];
  onToggleMulti: (id: number) => void;
  onLasso: (ids: number[]) => void;
  onSelectObject: (id: number) => void;
  /** Live geometry while an object or a vertex is dragged (the page draws it as a draft). */
  onObjectDraft: (id: number, geometry: course.CourseObject["geometry"] | null) => void;
  onObjectMoved: (id: number, geometry: course.CourseObject["geometry"]) => void;
  onLegDoubleClick: (target: Extract<EditorTarget, { kind: "leg" }>, pt: Pt) => void;
  /** Rings of the multi-selection, radius on paper. */
  ringMm: number;
  redraw: Redraw;
}

export function selectBinding(o: SelectOptions): EditorToolBinding {
  const g = o.gesture;
  const shapes: ToolShape[] = [];
  for (const obj of o.objects) {
    const selected = obj.id === o.selected?.id;
    // The layer draws neither regions nor toner savers on screen: the UI layer outlines them always.
    if (selected || obj.kind === "filter_region" || obj.kind === "toner_saver") shapes.push(...objectOutline(obj, selected));
  }
  const byId = new Map(o.sites.map((s) => [s.id, s] as const));
  for (const id of o.multi) {
    const s = byId.get(id);
    if (s) shapes.push({ kind: "circle", x: s.x, y: s.y, rMm: o.ringMm * 1.35, color: BLUE, testId: "editor-multi-ring", data: { "control-id": String(id) } });
  }
  const gs = g.current;
  if (gs?.kind === "lasso" && gs.points.length > 1) shapes.push({ kind: "line", points: gs.points, closed: true, dashed: true, color: BLUE, fill: "rgba(37,99,235,0.08)", testId: "editor-lasso" });
  return {
    shapes,
    onPointerDown(p: ToolPointer) {
      const sel = o.selected;
      if (sel) {
        const vertex = sel.geometry.findIndex((v) => near(v, p.pt, HANDLE_PX * p.mmPerPx));
        const onBody = p.target?.kind === "object" && p.target.id === sel.id;
        if (vertex >= 0 || onBody) {
          g.current = { kind: "object", id: sel.id, from: p.pt, to: p.pt, moved: false, vertex: vertex >= 0 ? vertex : null };
          return true;
        }
      }
      if (p.shift && p.target?.kind === "site") {
        g.current = { kind: "shift-click", id: Number(p.target.id) };
        return true;
      }
      if (p.shift && !p.target) {
        g.current = { kind: "lasso", points: [p.pt] };
        return true;
      }
      if (p.target?.kind === "object") {
        const obj = o.objects.find((x) => x.id === (p.target as { id: number }).id);
        if (obj) {
          g.current = { kind: "object", id: obj.id, from: p.pt, to: p.pt, moved: false, vertex: null };
          o.onSelectObject(obj.id);
          return true;
        }
      }
      return false;
    },
    onPointerDrag(pt) {
      const cur = g.current;
      if (cur?.kind === "lasso") {
        cur.points.push(pt);
        o.redraw();
      } else if (cur?.kind === "object") {
        cur.to = pt;
        cur.moved = cur.moved || !near(cur.from, pt, 0.05);
        const obj = o.objects.find((x) => x.id === cur.id);
        if (obj && cur.moved) o.onObjectDraft(obj.id, dragged(obj.geometry, cur));
      }
    },
    onPointerUp(pt) {
      const cur = g.current;
      g.current = null;
      if (!cur) return;
      if (cur.kind === "shift-click") {
        if (pt) o.onToggleMulti(cur.id);
      } else if (cur.kind === "lasso") {
        o.redraw();
        if (!pt || cur.points.length < 3) return;
        o.onLasso(o.sites.filter((s) => s.kind === "control" && pointInPolygon(s, cur.points)).map((s) => s.id));
      } else if (cur.kind === "object") {
        const obj = o.objects.find((x) => x.id === cur.id);
        if (pt) cur.to = pt;
        if (obj && pt && cur.moved) o.onObjectMoved(obj.id, dragged(obj.geometry, cur));
        else o.onObjectDraft(cur.id, null);
      }
    },
    onDoubleClick(p) {
      if (p.target?.kind === "leg") o.onLegDoubleClick(p.target, p.pt);
    },
  };
}

function dragged(geometry: course.CourseObject["geometry"], g: Extract<Gesture, { kind: "object" }>): course.CourseObject["geometry"] {
  const dx = g.to.x - g.from.x, dy = g.to.y - g.from.y;
  if (g.vertex === null) return translate(geometry, dx, dy);
  return geometry.map((v, i) => (i === g.vertex ? { ...v, x: v.x + dx, y: v.y + dy } : v));
}

// ─── S / K / M: the armed creation tools ──────────────────

export interface PlaceOptions {
  /** The ghost (UI layer): where, how big, what it reads; null without a hover. */
  ghost: {
    at: Pt;
    radiusMm: number;
    role: "start" | "control" | "finish";
    /** "3 · 47" (number · code), "Add 47" over an existing control, or the code. */
    label: string;
    description: string | null;
    legs: [Pt, Pt][];
  } | null;
  onHover: (p: ToolPointer | null) => void;
  onPlace: (p: ToolPointer) => void;
  onExit: () => void;
  touch: { placeLabel: string; doneLabel: string } | null;
}

export function placeBinding(o: PlaceOptions): EditorToolBinding {
  const shapes: ToolShape[] = [];
  const gh = o.ghost;
  if (gh) {
    for (const [a, b] of gh.legs) shapes.push({ kind: "line", points: [a, b], dashed: true, color: PURPLE, widthPx: 1.5, testId: "editor-pending-leg" });
    shapes.push({ kind: "circle", x: gh.at.x, y: gh.at.y, rMm: gh.radiusMm, color: PURPLE, testId: "editor-ghost", data: { role: gh.role } });
    if (gh.role === "finish") shapes.push({ kind: "circle", x: gh.at.x, y: gh.at.y, rMm: gh.radiusMm * 0.7, color: PURPLE });
    shapes.push({ kind: "text", x: gh.at.x, y: gh.at.y, text: gh.label, dxPx: 14, dyPx: -10, color: PURPLE, testId: "editor-ghost-label" });
    if (gh.description) shapes.push({ kind: "text", x: gh.at.x, y: gh.at.y, text: gh.description, dxPx: 14, dyPx: 6, color: "#475569", testId: "editor-ghost-description" });
  }
  return {
    exclusive: true,
    cursor: "crosshair",
    shapes,
    onHover: o.onHover,
    onClick: o.onPlace,
    onContextMenu: () => o.onExit(),
    touch: o.touch ? { ...o.touch, onPlace: o.onPlace, onDone: o.onExit } : null,
  };
}

// ─── A: area tools (polygon flow) ─────────────────────────

export interface AreaOptions {
  gesture: GestureRef;
  poly: PolygonState;
  hover: Pt | null;
  onHover: (p: ToolPointer | null) => void;
  onPoly: (poly: PolygonState) => void;
  onDone: (vertices: Pt[]) => void;
  onCancel: () => void;
  snap: (pt: Pt) => Pt;
}

export function areaBinding(o: AreaOptions): EditorToolBinding {
  const v = o.poly.vertices;
  const closed = isClosedKind(o.poly.kind);
  const shapes: ToolShape[] = [];
  const preview = o.hover ? [...v, o.hover] : v;
  if (preview.length >= 2) shapes.push({ kind: "line", points: preview, closed: closed && preview.length >= 3, dashed: true, color: PURPLE, fill: closed ? "rgba(124,58,237,0.08)" : undefined, testId: "editor-polygon" });
  v.forEach((p, i) => shapes.push({ kind: "handle", x: p.x, y: p.y, active: i === 0 && closed, testId: "editor-polygon-vertex", data: { index: String(i) } }));
  const apply = (e: Parameters<typeof step>[1]) => {
    const r = step(o.poly, e);
    if (r.done) o.onDone(r.done);
    else if (r.state !== o.poly) o.onPoly(r.state);
  };
  return {
    exclusive: true,
    cursor: "crosshair",
    shapes,
    onHover: o.onHover,
    onPointerDown(p) {
      const tol = HANDLE_PX * p.mmPerPx;
      const index = v.findIndex((q) => near(q, p.pt, tol));
      // The first vertex closes (a click); the others are dragged to adjust before closing.
      if (index > 0 || (index === 0 && !closed)) {
        o.gesture.current = { kind: "poly-vertex", index };
        return true;
      }
      return false;
    },
    onPointerDrag(pt) {
      const g = o.gesture.current;
      if (g?.kind === "poly-vertex") apply({ type: "move-vertex", index: g.index, pt: o.snap(pt) });
    },
    onPointerUp() {
      o.gesture.current = null;
    },
    onClick(p) {
      const tol = HANDLE_PX * p.mmPerPx;
      apply({ type: "click", pt: o.snap(p.pt), onFirst: v.length > 0 && near(v[0], p.pt, tol) });
    },
    onDoubleClick(p) {
      apply({ type: "double-click", pt: o.snap(p.pt) });
    },
    onContextMenu: () => o.onCancel(),
  };
}

// ─── T: map text ──────────────────────────────────────────

export function textBinding(o: { onPlace: (pt: Pt) => void; onExit: () => void; snap: (pt: Pt) => Pt }): EditorToolBinding {
  return { exclusive: true, cursor: "text", onClick: (p) => o.onPlace(o.snap(p.pt)), onContextMenu: () => o.onExit() };
}

// ─── G: gaps on the selected circle or leg ────────────────

export type GapTarget =
  | { kind: "circle"; siteId: number; centre: Pt; radiusMm: number; gaps: AngularGap[] }
  | { kind: "leg"; itemIndex: number; a: Pt; b: Pt; gaps: FractionGap[] };

export interface GapOptions {
  gesture: GestureRef;
  target: GapTarget;
  redraw: Redraw;
  onAdd: (gap: AngularGap | FractionGap) => void;
  onRemove: (index: number) => void;
  onExit: () => void;
}

const arcPoints = (c: Pt, r: number, g: AngularGap): Pt[] => {
  const sweep = (((g.end - g.start) % 360) + 360) % 360;
  const n = Math.max(2, Math.ceil(sweep / 5));
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = ((g.start + (sweep * i) / n) * Math.PI) / 180;
    return { x: c.x + r * Math.sin(a), y: c.y + r * Math.cos(a) };
  });
};

export function gapBinding(o: GapOptions): EditorToolBinding {
  const t = o.target;
  const shapes: ToolShape[] = [];
  const pending = o.gesture.current?.kind === "gap" ? o.gesture.current : null;
  if (t.kind === "circle") {
    shapes.push({ kind: "circle", x: t.centre.x, y: t.centre.y, rMm: t.radiusMm, dashed: true, color: BLUE, testId: "editor-gap-target", data: { kind: "circle", r: String(t.radiusMm) } });
    t.gaps.forEach((g, i) => shapes.push({ kind: "line", points: arcPoints(t.centre, t.radiusMm, g), color: "#f59e0b", widthPx: 5, testId: "editor-gap", data: { index: String(i), start: String(g.start), end: String(g.end) } }));
    const preview = pending ? circleGapFromDrag(t.centre, pending.from, pending.to) : null;
    if (preview) shapes.push({ kind: "line", points: arcPoints(t.centre, t.radiusMm, preview), color: BLUE, widthPx: 5, testId: "editor-gap-preview" });
  } else {
    const at = (f: number) => ({ x: t.a.x + (t.b.x - t.a.x) * f, y: t.a.y + (t.b.y - t.a.y) * f });
    shapes.push({ kind: "line", points: [t.a, t.b], dashed: true, color: BLUE, testId: "editor-gap-target", data: { kind: "leg" } });
    t.gaps.forEach((g, i) => shapes.push({ kind: "line", points: [at(g.from), at(g.to)], color: "#f59e0b", widthPx: 5, testId: "editor-gap", data: { index: String(i), from: String(g.from), to: String(g.to) } }));
    const preview = pending ? legGapFromDrag(t.a, t.b, pending.from, pending.to) : null;
    if (preview) shapes.push({ kind: "line", points: [at(preview.from), at(preview.to)], color: BLUE, widthPx: 5, testId: "editor-gap-preview" });
  }
  /** On the rim / leg within reach (screen px, at least 1 mm). */
  const onTarget = (p: ToolPointer) => {
    const reach = Math.max(1, 10 * p.mmPerPx);
    if (t.kind === "circle") return Math.abs(Math.hypot(p.pt.x - t.centre.x, p.pt.y - t.centre.y) - t.radiusMm) <= reach;
    const f = legFraction(t.a, t.b, p.pt);
    const q = { x: t.a.x + (t.b.x - t.a.x) * f, y: t.a.y + (t.b.y - t.a.y) * f };
    return Math.hypot(p.pt.x - q.x, p.pt.y - q.y) <= reach;
  };
  return {
    exclusive: true,
    cursor: "crosshair",
    shapes,
    onPointerDown(p) {
      if (!onTarget(p)) return false;
      o.gesture.current = { kind: "gap", from: p.pt, to: p.pt };
      return true;
    },
    onPointerDrag(pt) {
      const g = o.gesture.current;
      if (g?.kind === "gap") {
        g.to = pt;
        o.redraw();
      }
    },
    onPointerUp(pt) {
      const g = o.gesture.current;
      o.gesture.current = null;
      if (g?.kind !== "gap" || !pt) return o.redraw();
      g.to = pt;
      const gap = t.kind === "circle" ? circleGapFromDrag(t.centre, g.from, g.to) : legGapFromDrag(t.a, t.b, g.from, g.to);
      if (gap) return o.onAdd(gap);
      // A click on a gap removes it.
      const index = t.kind === "circle" ? circleGapAt(t.gaps, compassDeg(t.centre, pt)) : legGapAt(t.gaps, legFraction(t.a, t.b, pt));
      if (index >= 0) o.onRemove(index);
      else o.redraw();
    },
    onContextMenu: () => o.onExit(),
  };
}
