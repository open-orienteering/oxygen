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
import { dragBendGrip, legPolyline, moveBend, polylineDistance, polylineSlice, toggleBendSmooth, type Bend } from "../../../lib/editor/bends";
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
  /** Bend `index` of the selected leg dragged from `press` (§6.7); `bends` is the live list; `alt` is the press's (a click with it toggles corner / smooth). */
  | { kind: "bend"; index: number; press: Pt; mmPerPx: number; bends: Bend[]; moved: boolean; alt: boolean }
  /** A grip (handle `which`) of bend `index` dragged from `press` by the pointer's offset (§6.7, F16); `base` at the press, `bends` live; `alt` live breaks the pair. */
  | { kind: "bend-grip"; index: number; which: "in" | "out"; press: Pt; mmPerPx: number; base: readonly Bend[]; bends: Bend[]; moved: boolean }
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

// ─── The corridor guide (§6.7, F14) ─────────────────────

/** A corridor leg of the selected course: the layer draws no line along it (course-layer.md §10.2). */
export interface CorridorGuide {
  /** The derived course's id (the course name), and the leg's index in it. */
  course: string;
  index: number;
  /** The derived leg's points (bends and crossing joined), paper mm. */
  points: readonly Pt[];
}

/**
 * `binding` with a blue dashed `editor-corridor-guide` along each corridor
 * leg, under the tool's own shapes. The guide only draws: a press on it is
 * the viewer's leg click (the leg hits through the UI legs, §5), and every
 * hook of the tool is kept. With no binding the guides draw alone.
 */
export function withCorridorGuides(binding: EditorToolBinding | null, guides: readonly CorridorGuide[]): EditorToolBinding | null {
  if (guides.length === 0) return binding;
  const lines: ToolShape[] = guides.map((g) => ({
    kind: "line", points: g.points, dashed: true, color: BLUE, testId: "editor-corridor-guide", data: { course: g.course, leg: String(g.index) },
  }));
  return { ...binding, shapes: [...lines, ...(binding?.shapes ?? [])] };
}

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
  /** The selected leg (its phantom) with its bends, desktop and tablet (§6.7): handles to drag and focus. */
  leg?: LegBends | null;
}

/** The selected leg's bends as `V` edits them (docs/course-editor.md §6.7). */
export interface LegBends {
  from: Pt;
  to: Pt;
  /** The stored bends: path vertices with optional handles (F13). */
  bends: readonly Bend[];
  /** The focused bend (`Delete` removes it). */
  focused: number | null;
  /** One write per gesture (a drag, on release; an Alt-click). */
  onBendsChange: (bends: Bend[]) => void;
  /**
   * The live bends of a bend or grip drag, on every move past 3 px (F21: the page hands them to the layer); null when
   * the drag is cancelled. A committing release reports none: its `onBendsChange` takes over (the page holds the draft
   * until the list carries the write).
   */
  onBendsDraft?: (bends: Bend[] | null) => void;
  onBendFocus: (index: number | null) => void;
  snap: (pt: Pt) => Pt;
}

/** The grip of a bend's handle within reach of `pt` (the first in order); null when none. */
function bendGripAt(leg: LegBends, pt: Pt, reach: number): { index: number; which: "in" | "out" } | null {
  for (const [index, b] of leg.bends.entries()) {
    const grip = gripsOf(b).find((q) => near(q.at, pt, reach));
    if (grip) return { index, which: grip.which };
  }
  return null;
}

/** The bend handle within reach of `pt`, nearest first; −1 when none. */
function bendAt(leg: LegBends, pt: Pt, reach: number): number {
  let best = -1, bestD = Infinity;
  leg.bends.forEach((b, i) => {
    const d = Math.hypot(b.x - pt.x, b.y - pt.y);
    if (d <= reach && d < bestD) { best = i; bestD = d; }
  });
  return best;
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
  const leg = o.leg ?? null;
  if (leg) {
    // The live list during a bend or grip drag; the outline is the flattened curve the layer draws (F16).
    const bends = gs?.kind === "bend" || gs?.kind === "bend-grip" ? gs.bends : leg.bends;
    shapes.push({ kind: "line", points: legPolyline(leg.from, bends, leg.to), dashed: true, color: BLUE, testId: "editor-leg-outline" });
    bends.forEach((b, i) => {
      const focused = gs?.kind === "bend" || gs?.kind === "bend-grip" ? gs.index === i : leg.focused === i;
      shapes.push({ kind: "handle", x: b.x, y: b.y, active: focused, testId: "editor-bend-handle", data: { index: String(i), focused: String(focused) } });
    });
    bends.forEach((b, i) => {
      for (const q of gripsOf(b)) shapes.push({ kind: "grip", x: q.at.x, y: q.at.y, from: b, testId: "editor-bend-grip", data: { index: String(i), which: q.which } });
    });
  }
  if (gs?.kind === "lasso" && gs.points.length > 1) shapes.push({ kind: "line", points: gs.points, closed: true, dashed: true, color: BLUE, fill: "rgba(37,99,235,0.08)", testId: "editor-lasso" });
  return {
    shapes,
    // A tablet's finger drags the selected leg's bends and grips (F23); everything else keeps the viewer's touch rules.
    touchPress: !!leg,
    onPointerDown(p: ToolPointer) {
      // A bend handle of the selected leg first, then a grip of one: they sit on or by the leg, which the viewer
      // would take as a leg click. A finger reaches twice as far (§10, as `onPinch`).
      const reach = (p.touch ? 2 : 1) * HANDLE_PX * p.mmPerPx;
      const bend = leg ? bendAt(leg, p.pt, reach) : -1;
      if (leg && bend >= 0) {
        g.current = { kind: "bend", index: bend, press: p.pt, mmPerPx: p.mmPerPx, bends: [...leg.bends], moved: false, alt: !!p.alt };
        return true;
      }
      const grip = leg ? bendGripAt(leg, p.pt, reach) : null;
      if (leg && grip) {
        g.current = { kind: "bend-grip", ...grip, press: p.pt, mmPerPx: p.mmPerPx, base: leg.bends, bends: [...leg.bends], moved: false };
        return true;
      }
      // A finger elsewhere is the viewer's: its targets, a pan, the tap that selects an object (§10).
      if (p.touch) return false;
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
      } else if (cur?.kind === "bend" && leg) {
        // Past 3 px from the press it is a drag; until then a click (a focus).
        if (!cur.moved && near(cur.press, pt, 3 * cur.mmPerPx)) return;
        cur.moved = true;
        cur.bends = moveBend(cur.bends, cur.index, leg.snap(pt));
        leg.onBendsDraft?.(cur.bends);
        o.redraw();
        return { x: cur.bends[cur.index].x, y: cur.bends[cur.index].y };
      } else if (cur?.kind === "bend-grip" && leg) {
        if (!cur.moved && near(cur.press, pt, 3 * cur.mmPerPx)) return;
        cur.moved = true;
        cur.bends = gripDragged(cur, pt, mods);
        leg.onBendsDraft?.(cur.bends);
        o.redraw();
        return gripPoint(cur.bends[cur.index], cur.which);
      } else if (cur?.kind === "object" || cur?.kind === "grip") {
        const geometry = dragGeometry(cur, pt, mods);
        if (geometry) o.onObjectDraft(cur.id, geometry);
        // The placed point: the dragged vertex or grip (a body drag places none).
        if (!geometry) return;
        if (cur.kind === "grip") return gripPoint(geometry[cur.index], cur.which);
        if (cur.vertex !== null) return { x: geometry[cur.vertex].x, y: geometry[cur.vertex].y };
      }
    },
    onPointerUp(pt) {
      const cur = g.current;
      g.current = null;
      if (!cur) return;
      if (cur.kind === "bend") {
        o.redraw();
        if (!leg) return;
        // A cancelled drag drops its draft (F21); a click never made one.
        if (!pt) return void (cur.moved && leg.onBendsDraft?.(null));
        leg.onBendFocus(cur.index);
        if (cur.moved) return leg.onBendsChange(moveBend(cur.bends, cur.index, leg.snap(pt)));
        // A click focuses; with Alt it also toggles the bend corner / smooth (F18's Alt-click, §7).
        const toggled = cur.alt ? toggleBendSmooth(leg.from, leg.bends, leg.to, cur.index) : null;
        if (toggled) leg.onBendsChange(toggled);
        return;
      }
      if (cur.kind === "bend-grip") {
        o.redraw();
        // A click on a grip does nothing; a drag writes once and focuses its bend.
        if (!leg || !cur.moved) return;
        if (!pt) return leg.onBendsDraft?.(null);
        leg.onBendFocus(cur.index);
        return leg.onBendsChange(cur.bends);
      }
      if (cur.kind === "shift-click") {
        if (pt) o.onToggleMulti(cur.id);
      } else if (cur.kind === "lasso") {
        o.redraw();
        if (!pt || cur.points.length < 3) return;
        o.onLasso(o.sites.filter((s) => s.kind === "control" && pointInPolygon(s, cur.points)).map((s) => s.id));
      } else if (cur.kind === "object" || cur.kind === "grip") {
        // A drag commits; a click focuses a vertex (Alt: toggles corner / smooth) or, on the body, unfocuses.
        const r = releaseGeometry(cur, pt, vertexRule(shown(o)?.kind ?? ""));
        if (r?.kind === "commit") o.onObjectMoved(cur.id, r.geometry);
        else if (r?.kind === "cancel") o.onObjectDraft(cur.id, null);
        else if (r?.kind === "focus") o.onVertexFocus?.(r.index);
      }
    },
    onDoubleClick(p) {
      // On a bend handle: the press's focus already happened; no control is inserted under it (§6.7).
      if (leg && (bendAt(leg, p.pt, HANDLE_PX * p.mmPerPx) >= 0 || bendGripAt(leg, p.pt, HANDLE_PX * p.mmPerPx))) return;
      // On the selected object's edge, off its vertices: a smooth vertex there, Alt a corner (§7 "Editing geometry").
      const sel = shown(o);
      const inserted = sel ? insertAtEdge(sel.geometry, vertexRule(sel.kind), p.pt, HANDLE_PX * p.mmPerPx, !!p.alt) : null;
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

/** Where the grip of handle `which` of vertex `v` lies (the vertex itself without that handle). */
function gripPoint(v: { x: number; y: number; hIn?: Pt; hOut?: Pt }, which: "in" | "out"): Pt {
  const h = (which === "out" ? v.hOut : v.hIn) ?? { x: 0, y: 0 };
  return { x: v.x + h.x, y: v.y + h.y };
}

/** A bend grip's drag at `pt`: the handle moved by the pointer's offset from the press (`dragBendGrip`; Alt and Shift live). */
function gripDragged(d: Extract<Gesture, { kind: "bend-grip" }>, pt: Pt, mods?: { shift: boolean; alt: boolean }): Bend[] {
  const b = d.base[d.index];
  const h = (d.which === "out" ? b.hOut : b.hIn) ?? { x: 0, y: 0 };
  const vec = { x: h.x + pt.x - d.press.x, y: h.y + pt.y - d.press.y };
  return dragBendGrip(d.base, d.index, d.which, vec, mods?.alt ?? false, mods?.shift ?? false);
}

/** The selected object as the page shows it (a draft from the last gesture until the list catches up). */
const shown = (o: SelectOptions): course.CourseObject | null => (o.selected ? o.objects.find((x) => x.id === o.selected!.id) ?? o.selected : null);

// ─── S / K / M: the armed creation tools ──────────────────

export interface PlaceOptions {
  /** The ghost (UI layer): where, how big, what it reads; null without a hover. */
  ghost: {
    at: Pt;
    radiusMm: number;
    role: "start" | "control" | "finish" | "crossing_point";
    /** A crossing point's direction of passage, degrees counter-clockwise from +x (§6.8); default north. */
    angleDeg?: number;
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

/** Half the ghost 710's length and its lines' offset from the passage, paper mm (ISOM 710 at the library size). */
const CROSSING_GHOST_HALF_MM = 1.5;
const CROSSING_GHOST_OFFSET_MM = 0.475;

/** The crossing tool's ghost: two lines either side of the passage through `at`, turned by `angleDeg`. */
export function crossingGhost(at: Pt, angleDeg: number): ToolShape[] {
  const a = (angleDeg * Math.PI) / 180;
  const ux = Math.cos(a), uy = Math.sin(a);
  const line = (off: number): Pt[] => [
    { x: at.x - ux * CROSSING_GHOST_HALF_MM - uy * off, y: at.y - uy * CROSSING_GHOST_HALF_MM + ux * off },
    { x: at.x + ux * CROSSING_GHOST_HALF_MM - uy * off, y: at.y + uy * CROSSING_GHOST_HALF_MM + ux * off },
  ];
  return [
    { kind: "line", points: line(CROSSING_GHOST_OFFSET_MM), color: PURPLE, widthPx: 2, testId: "editor-ghost", data: { role: "crossing_point", angle: String(Math.round(angleDeg * 10) / 10) } },
    { kind: "line", points: line(-CROSSING_GHOST_OFFSET_MM), color: PURPLE, widthPx: 2 },
  ];
}

export function placeBinding(o: PlaceOptions): EditorToolBinding {
  const shapes: ToolShape[] = [];
  const gh = o.ghost;
  if (gh) {
    const leg = gh.legs[0];
    if (leg && gh.legLabel) shapes.push(legLengthShape(leg[0], leg[1], gh.legLabel));
    if (gh.role === "crossing_point") {
      // 710's two lines along the passage (§6.8); the layer draws no visit for a crossing point.
      shapes.push(...crossingGhost(gh.at, gh.angleDeg ?? 90));
    } else if (!o.provisionalDrawn) {
      // The circle only where the layer draws none (no course, a reuse): else two concentric circles show.
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
  // No rubber-band vertex while a press is placing one (the hover is where the press began). The hover
  // is previewed as the smooth vertex a plain click places (F18), and the smooth vertices show their
  // provisional handles with it as the next vertex (and, closed, as the first one's prev); nothing
  // provisional is written to the state, and only its handles get grips.
  const preview = o.hover && o.gesture.current?.kind !== "poly-pull" ? [...v, o.hover] : v;
  const ring = closed && preview.length >= 3;
  if (preview.length >= 2) shapes.push({ kind: "line", points: outlinePoints(smoothed(preview, ring, vertexRule(o.poly.kind).curves), ring), closed: ring, dashed: true, color: PURPLE, fill: closed ? "rgba(124,58,237,0.08)" : undefined, testId: "editor-polygon" });
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
      // Anywhere else the press places a smooth vertex now (Alt: a corner, F18); a drag from it pulls
      // its handles by hand (click-drag = curve, the pull beating Alt; back within 3 px, the press's kind).
      const pt = o.snap(p.pt);
      const r = step(o.poly, { type: "click", pt, onFirst: false, corner: !!p.alt });
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
      apply({ type: "click", pt: o.snap(p.pt), onFirst: v.length > 0 && near(v[0], p.pt, tol), corner: !!p.alt });
    },
    onDoubleClick(p) {
      apply({ type: "double-click", pt: o.snap(p.pt), corner: !!p.alt });
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
  /** `points`: the leg's polyline — the previous site, its bends, the site (docs/course-editor.md §6.3). */
  | { kind: "leg"; itemIndex: number; points: Pt[]; gaps: FractionGap[]; stored?: boolean };

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
    shapes.push({ kind: "line", points: t.points, dashed: true, color: BLUE, testId: "editor-gap-target", data: { kind: "leg" } });
    t.gaps.forEach((g, i) => shapes.push({ kind: "line", points: polylineSlice(t.points, g.from, g.to), color: "#f59e0b", widthPx: 5, testId: "editor-gap", data: { index: String(i), from: String(g.from), to: String(g.to) } }));
    const preview = pending ? legGapFromDrag(t.points, pending.from, pending.to) : null;
    if (preview) shapes.push({ kind: "line", points: polylineSlice(t.points, preview.from, preview.to), color: BLUE, widthPx: 5, testId: "editor-gap-preview" });
  }
  /** On the rim / leg within reach (screen px, at least 1 mm). */
  const onTarget = (p: ToolPointer) => {
    const reach = Math.max(1, 10 * p.mmPerPx);
    if (t.kind === "circle") return Math.abs(Math.hypot(p.pt.x - t.centre.x, p.pt.y - t.centre.y) - t.radiusMm) <= reach;
    return polylineDistance(t.points, p.pt) <= reach;
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
      const gap = t.kind === "circle" ? circleGapFromDrag(t.centre, g.from, g.to) : legGapFromDrag(t.points, g.from, g.to);
      if (gap) return o.onAdd(gap);
      // A click on a gap removes it.
      const index = t.kind === "circle" ? circleGapAt(t.gaps, compassDeg(t.centre, pt)) : legGapAt(t.gaps, legFraction(t.points, pt));
      if (index >= 0) o.onRemove(index);
      else o.redraw();
    },
    onContextMenu: () => o.onExit(),
  };
}
