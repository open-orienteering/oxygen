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
import { legLengthShape } from "../../../lib/editor/leg-length";
import { isClosedKind, pointInPolygon, smoothed, step, type PolygonState } from "./polygon";
import { outlinePoints, vertexRule, type Vertex } from "../../../lib/editor/geometry-edit";
import {
  dragGeometry, geometryHandles, geometryShapes, gripsOf, insertAtEdge, pressGeometry, releaseGeometry, type GeometryDrag,
} from "../../../lib/editor/geometry-gestures";

type Pt = { x: number; y: number };

/** Handles grab within this many CSS px. */
export const HANDLE_PX = 7;

export type Gesture =
  | { kind: "lasso"; points: Pt[] }
  | { kind: "shift-click"; id: number }
  /** Object `id`'s geometry dragged: the whole path, a vertex, or a handle grip (§7 "Editing geometry", `geometry-gestures.ts`). */
  | ({ id: number } & GeometryDrag)
  /** Two fingers on a selected object's handle ring (§10): scale `base` about its centroid. */
  | { kind: "pinch"; id: number; base: course.CourseObject["geometry"]; centre: Pt; scale: number }
  | { kind: "poly-vertex"; index: number }
  /** A press at `press` while drawing placed vertex `index` (snapped); a drag past 3 px from the press pulls its handles (§6.4). */
  | { kind: "poly-pull"; index: number; press: Pt; mmPerPx: number; poly: PolygonState; pulled: boolean }
  | { kind: "gap"; from: Pt; to: Pt }
  | null;

export interface GestureRef { current: Gesture }

/** Re-render the page: a gesture in `GestureRef` changed what the tool draws. */
export type Redraw = () => void;

const PURPLE = "#7c3aed";
const BLUE = "#2563eb";

const near = (a: Pt, b: Pt, mm: number) => Math.hypot(a.x - b.x, a.y - b.y) <= mm;

/** `g` scaled by `k` about `c`; Bézier handles (offsets from their vertex) scale with it. */
export function scaleAbout(g: readonly course.CourseObject["geometry"][number][], c: Pt, k: number): course.CourseObject["geometry"] {
  return g.map((v) => ({
    ...v,
    x: c.x + (v.x - c.x) * k,
    y: c.y + (v.y - c.y) * k,
    ...(v.hIn ? { hIn: { x: v.hIn.x * k, y: v.hIn.y * k } } : {}),
    ...(v.hOut ? { hOut: { x: v.hOut.x * k, y: v.hOut.y * k } } : {}),
  }));
}

/**
 * Outline shapes of an object (selection, or the outline of a kind the layer does not draw on screen): the path
 * with each curve sampled (§7 "Editing geometry"); when selected, a handle per vertex (`focused` drawn active) and
 * a grip per Bézier handle.
 */
export function objectOutline(o: course.CourseObject, selected: boolean, focused: number | null = null): ToolShape[] {
  if (o.kind === "text") {
    const at = o.geometry[0];
    return [
      { kind: "circle", x: at.x, y: at.y, rMm: 0.6, color: selected ? BLUE : PURPLE, testId: "editor-object-outline", data: { "object-id": String(o.id) } },
      ...(selected ? geometryHandles(o.geometry, focused, OBJECT_IDS) : []),
    ];
  }
  return geometryShapes(o.geometry, vertexRule(o.kind).closed, { selected, focused, ids: OBJECT_IDS, data: { "object-id": String(o.id), "object-kind": o.kind } });
}

const OBJECT_IDS = { outline: "editor-object-outline", handle: "editor-object-handle", grip: "editor-object-grip" };

// ─── V: select / move, Shift-click, lasso, objects, double-click leg ──

export interface SelectOptions {
  gesture: GestureRef;
  /** The selected object, if any (handles and body drag). */
  selected: course.CourseObject | null;
  /** The selected object's focused vertex (a click on its handle): `Delete` removes it (§7 "Editing geometry"). */
  focusedVertex?: number | null;
  onVertexFocus?: (index: number | null) => void;
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
    if (selected || obj.kind === "filter_region" || obj.kind === "toner_saver") shapes.push(...objectOutline(obj, selected, selected ? o.focusedVertex ?? null : null));
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
      const sel = shown(o);
      if (sel) {
        // Vertex, grip, then the body or within reach of its edge. A closed area's body is its outline: the hit-test
        // answers null inside it (§5), so an interior press declines and the viewer pans — the area moves by its edge
        // or a vertex (docs/bugfix-editor-area-press-pans.md).
        const onBody = p.target?.kind === "object" && p.target.id === sel.id;
        const d = pressGeometry(sel.geometry, vertexRule(sel.kind), { pt: p.pt, reach: HANDLE_PX * p.mmPerPx, alt: p.alt, shift: p.shift }, onBody);
        if (d) {
          g.current = { ...d, id: sel.id };
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
          g.current = { kind: "object", id: obj.id, from: p.pt, to: p.pt, moved: false, vertex: null, base: obj.geometry };
          o.onSelectObject(obj.id);
          return true;
        }
      }
      return false;
    },
    onPointerDrag(pt, mods) {
      const cur = g.current;
      if (cur?.kind === "lasso") {
        cur.points.push(pt);
        o.redraw();
      } else if (cur?.kind === "object" || cur?.kind === "grip") {
        const geometry = dragGeometry(cur, pt, mods);
        if (geometry) o.onObjectDraft(cur.id, geometry);
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
      } else if (cur.kind === "object" || cur.kind === "grip") {
        // A drag commits; a click focuses a vertex (Alt: retracts its handles) or, on the body, unfocuses.
        const r = releaseGeometry(cur, pt, vertexRule(shown(o)?.kind ?? ""));
        if (r?.kind === "commit") o.onObjectMoved(cur.id, r.geometry);
        else if (r?.kind === "cancel") o.onObjectDraft(cur.id, null);
        else if (r?.kind === "focus") o.onVertexFocus?.(r.index);
      }
    },
    onDoubleClick(p) {
      // On the selected object's edge, off its vertices: a vertex there (§7 "Editing geometry").
      const sel = shown(o);
      const inserted = sel ? insertAtEdge(sel.geometry, vertexRule(sel.kind), p.pt, HANDLE_PX * p.mmPerPx) : null;
      if (sel && inserted) {
        o.onVertexFocus?.(inserted.index);
        return o.onObjectMoved(sel.id, inserted.geometry);
      }
      if (p.target?.kind === "leg") o.onLegDoubleClick(p.target, p.pt);
    },
    onPinch: {
      // A finger on a handle of the selected area object (or line) starts the scale; otherwise the map pinches.
      start(a, b) {
        const sel = o.selected;
        if (!sel || sel.geometry.length < 2) return false;
        const onRing = [a, b].some((p) => sel.geometry.some((v) => near(v, p.pt, 2 * HANDLE_PX * p.mmPerPx)));
        if (!onRing) return false;
        const centre = { x: sel.geometry.reduce((sum, v) => sum + v.x, 0) / sel.geometry.length, y: sel.geometry.reduce((sum, v) => sum + v.y, 0) / sel.geometry.length };
        g.current = { kind: "pinch", id: sel.id, base: sel.geometry, centre, scale: 1 };
        return true;
      },
      move(scale) {
        const cur = g.current;
        if (cur?.kind !== "pinch") return;
        cur.scale = scale;
        o.onObjectDraft(cur.id, scaleAbout(cur.base, cur.centre, scale));
      },
      end(commit) {
        const cur = g.current;
        g.current = null;
        if (cur?.kind !== "pinch") return;
        if (commit && Math.abs(cur.scale - 1) > 0.01) o.onObjectMoved(cur.id, scaleAbout(cur.base, cur.centre, cur.scale));
        else o.onObjectDraft(cur.id, null);
      },
    },
  };
}

/** The selected object as the page shows it (a draft from the last gesture until the list catches up). */
const shown = (o: SelectOptions): course.CourseObject | null => (o.selected ? o.objects.find((x) => x.id === o.selected!.id) ?? o.selected : null);

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
    /** The pending legs (the layer draws them from the provisional visit); the first one is labelled. */
    legs: [Pt, Pt][];
    /** The first leg's length, "123 m"; null without a map scale. */
    legLabel: string | null;
  } | null;
  /**
   * The layer draws the visit's circle at the ghost (`provisionalDrawn`,
   * lib/course-layer-request.ts): then the UI layer draws no circle of its
   * own, only the label, description and leg length (§6.1, P4).
   */
  provisionalDrawn: boolean;
  onHover: (p: ToolPointer | null) => void;
  onPlace: (p: ToolPointer) => void;
  onExit: () => void;
  touch: { placeLabel: string; doneLabel: string } | null;
}

export function placeBinding(o: PlaceOptions): EditorToolBinding {
  const shapes: ToolShape[] = [];
  const gh = o.ghost;
  if (gh) {
    const leg = gh.legs[0];
    if (leg && gh.legLabel) shapes.push(legLengthShape(leg[0], leg[1], gh.legLabel));
    // The circle only where the layer draws none (no course, a reuse): else two concentric circles show.
    if (!o.provisionalDrawn) {
      shapes.push({ kind: "circle", x: gh.at.x, y: gh.at.y, rMm: gh.radiusMm, color: PURPLE, testId: "editor-ghost", data: { role: gh.role } });
      if (gh.role === "finish") shapes.push({ kind: "circle", x: gh.at.x, y: gh.at.y, rMm: gh.radiusMm * 0.7, color: PURPLE });
    }
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
  onDone: (vertices: Vertex[]) => void;
  onCancel: () => void;
  snap: (pt: Pt) => Pt;
}

export function areaBinding(o: AreaOptions): EditorToolBinding {
  const v = o.poly.vertices;
  const closed = isClosedKind(o.poly.kind);
  const shapes: ToolShape[] = [];
  // No rubber-band vertex while a press is placing one (the hover is where the press began). Smooth
  // vertices preview their provisional handles with the hover as the next vertex (and, closed, as the
  // first one's prev); nothing provisional is written to the state, and only its handles get grips.
  const preview = o.hover && o.gesture.current?.kind !== "poly-pull" ? [...v, o.hover] : v;
  const ring = closed && preview.length >= 3;
  if (preview.length >= 2) shapes.push({ kind: "line", points: outlinePoints(smoothed(preview, ring), ring), closed: ring, dashed: true, color: PURPLE, fill: closed ? "rgba(124,58,237,0.08)" : undefined, testId: "editor-polygon" });
  v.forEach((p, i) => {
    shapes.push({ kind: "handle", x: p.x, y: p.y, active: i === 0 && closed, testId: "editor-polygon-vertex", data: { index: String(i) } });
    for (const g of gripsOf(p)) shapes.push({ kind: "grip", x: g.at.x, y: g.at.y, from: p, testId: "editor-polygon-grip", data: { index: String(i), which: g.which } });
  });
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
      if (index === 0) return false;
      // Anywhere else the press places a corner now (Alt: a smooth vertex); a drag from it pulls its
      // handles (click = corner, click-drag = curve, the pull beating Alt).
      const pt = o.snap(p.pt);
      const r = step(o.poly, { type: "click", pt, onFirst: false, smooth: !!p.alt });
      if (r.state !== o.poly) o.onPoly(r.state);
      o.gesture.current = { kind: "poly-pull", index: r.state.vertices.length - 1, press: p.pt, mmPerPx: p.mmPerPx, poly: r.state, pulled: false };
      return true;
    },
    onPointerDrag(pt, mods) {
      const g = o.gesture.current;
      if (g?.kind === "poly-vertex") apply({ type: "move-vertex", index: g.index, pt: o.snap(pt) });
      else if (g?.kind === "poly-pull") {
        // Within 3 px of the press it is a corner (before the pull, and again when the drag comes back).
        const corner = near(g.press, pt, 3 * g.mmPerPx);
        if (!g.pulled && corner) return;
        g.pulled = true;
        const vec = corner ? { x: 0, y: 0 } : { x: pt.x - g.press.x, y: pt.y - g.press.y };
        const r = step(g.poly, { type: "pull-handles", index: g.index, vec, shift: mods?.shift ?? false });
        if (r.state !== g.poly) o.onPoly(r.state);
      }
    },
    onPointerUp() {
      o.gesture.current = null;
    },
    onClick(p) {
      const tol = HANDLE_PX * p.mmPerPx;
      apply({ type: "click", pt: o.snap(p.pt), onFirst: v.length > 0 && near(v[0], p.pt, tol), smooth: !!p.alt });
    },
    onDoubleClick(p) {
      apply({ type: "double-click", pt: o.snap(p.pt), smooth: !!p.alt });
    },
    onContextMenu: () => o.onCancel(),
  };
}

// ─── T: map text ──────────────────────────────────────────

export function textBinding(o: { onPlace: (pt: Pt) => void; onExit: () => void; snap: (pt: Pt) => Pt }): EditorToolBinding {
  return { exclusive: true, cursor: "text", onClick: (p) => o.onPlace(o.snap(p.pt)), onContextMenu: () => o.onExit() };
}

// ─── The filter region's eyedropper (§6.4) ────────────────

/** The eyedropper's reach around the click, CSS px. */
export const PICK_PX = 6;

/** Exclusive: a click (a tap) picks the map symbol at the pointer, `toleranceMm` from `tolerancePx` at this zoom; a drag pans. */
export function pickSymbolBinding(o: { onPick: (pt: Pt, toleranceMm: number) => void; onExit: () => void; tolerancePx?: number }): EditorToolBinding {
  return {
    exclusive: true,
    cursor: "crosshair",
    onClick: (p) => o.onPick(p.pt, (o.tolerancePx ?? PICK_PX) * p.mmPerPx),
    onContextMenu: () => o.onExit(),
  };
}

// ─── G: gaps on the selected circle or leg ────────────────

/** `gaps`: the effective ones (stored, else automatic); `stored`: whether a list is stored (Reset gaps applies). */
export type GapTarget =
  | { kind: "circle"; siteId: number; centre: Pt; radiusMm: number; gaps: AngularGap[]; stored?: boolean }
  | { kind: "leg"; itemIndex: number; a: Pt; b: Pt; gaps: FractionGap[]; stored?: boolean };

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
