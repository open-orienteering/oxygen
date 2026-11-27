/**
 * The viewer bindings of the editor's tools (docs/course-editor.md §6, §7):
 * what each tool does with the pointer and what it draws on the UI layer.
 * The page builds one per render from its state; a gesture in progress
 * lives in `gesture` (a ref the page owns), so a re-render mid-drag keeps
 * it. Writes go out through the callbacks.
 */

import type { course } from "@oxygen/shared";
import type { EditorToolBinding, ToolPointer, ToolShape } from "../../../components/MapViewer";
import { imageRing, type EditorTarget } from "../../../lib/editor/hit";
import { IMAGE_MIN_MM } from "../../../lib/editor/image-box";
import {
  anchorKnob, cropEdge, edgeHandles, knobBase, resizeBox, rotationAt, ROTATE_STEM_PX, uncroppedRing, type BoxEdge,
} from "../../../lib/editor/transform-gestures";
import type { Crop } from "../../../lib/editor/style-fields";
import { circleGapAt, circleGapFromDrag, compassDeg, legFraction, legGapAt, legGapFromDrag, type AngularGap, type FractionGap } from "./gaps";
import { dragBendGrip, insertBendAt, legPolyline, moveBend, polylineDistance, polylineSlice, toggleBendSmooth, type Bend } from "../../../lib/editor/bends";
import { legLengthShape } from "../../../lib/editor/leg-length";
import { isClosedKind, pointInPolygon, smoothed, step, type PolygonState } from "./polygon";
import { nearestEdge, outlinePoints, vertexRule, type Vertex } from "../../../lib/editor/geometry-edit";
import { ringRule } from "../modes/map/nodes";
import { angleOfDrag } from "../modes/map/symbols";
import { hoverCandidate, liveTrim, trackToolStep, type SplitCandidate, type TrackToolState, type TrackToolStep, type TrackToolTarget } from "./tracks";
import { nodesNear } from "../modes/map/tracks/edit";
import type { gpsTrack } from "@oxygen/shared";
import {
  dragGeometry, geometryHandles, geometryShapes, gripsOf, insertAtEdge, pressGeometry, releaseGeometry, type GeometryDrag,
} from "../../../lib/editor/geometry-gestures";

type Pt = { x: number; y: number };

/** Handles grab within this many CSS px. */
export const HANDLE_PX = 7;

export type Gesture =
  | { kind: "lasso"; points: Pt[] }
  | { kind: "shift-click"; id: number }
  /** J16: a Shift- or Ctrl-click on a course object (added to or taken out of the object multi-selection on release). */
  | { kind: "object-toggle"; id: number }
  /** J16: a press on a member of the object multi-selection: a drag moves them all, a click selects that one. */
  | { kind: "group"; id: number; bases: ReadonlyMap<number, course.CourseObject["geometry"]>; from: Pt; to: Pt; mmPerPx: number; moved: boolean }
  /** Object `id`'s geometry dragged: the whole path, a vertex, or a handle grip (§7 "Editing geometry", `geometry-gestures.ts`). */
  | ({ id: number } & GeometryDrag)
  /** A corner (`imageRing` index) of the selected image dragged from `press` (J7): the opposite corner stays put. */
  | { kind: "image-corner"; id: number; corner: number; base: course.CourseObject["geometry"]; rotationDeg: number; press: Pt; mmPerPx: number; moved: boolean; shift: boolean }
  /** The rotate knob of the selected image or text (J11): the pointer's turn about `pivot` since `press`; Shift snaps to 15°. */
  | { kind: "rotate"; id: number; base: StyledObject; pivot: Pt; press: Pt; to: Pt; shift: boolean; mmPerPx: number; moved: boolean }
  /** A crop edge of the selected image in crop mode (J11): that crop side follows the pointer. */
  | { kind: "crop"; id: number; edge: BoxEdge; base: Extract<course.CourseObject, { kind: "image" }>; to: Pt; mmPerPx: number; moved: boolean }
  /** Two fingers on a selected object's handle ring (§10): scale `base` about its centroid. */
  | { kind: "pinch"; id: number; base: course.CourseObject["geometry"]; centre: Pt; scale: number }
  | { kind: "poly-vertex"; index: number }
  /** A press at `press` while drawing placed vertex `index` (snapped); a drag past 3 px from the press pulls its handles (§6.4). */
  | { kind: "poly-pull"; index: number; press: Pt; mmPerPx: number; poly: PolygonState; pulled: boolean }
  | { kind: "gap"; from: Pt; to: Pt }
  /** Bend `index` of the selected leg dragged from `press` (§6.7); `bends` is the live list; `alt` is the press's (a click with it toggles corner / smooth). */
  | { kind: "bend"; index: number; press: Pt; mmPerPx: number; bends: Bend[]; moved: boolean; alt: boolean }
  /** A press on the selected leg's line (§6.7): past 3 px it becomes a new bend at the press, dragged (`bend`); released before, a click on the leg. */
  | { kind: "bend-new"; press: Pt; mmPerPx: number; alt: boolean }
  /** A grip (handle `which`) of bend `index` dragged from `press` by the pointer's offset (§6.7, F16); `base` at the press, `bends` live; `alt` live breaks the pair. */
  | { kind: "bend-grip"; index: number; which: "in" | "out"; press: Pt; mmPerPx: number; base: readonly Bend[]; bends: Bend[]; moved: boolean }
  | null;

export interface GestureRef { current: Gesture }

/** The kinds the canvas turns by a knob (J11): an image about its centre, a text about its anchor. */
type StyledObject = Extract<course.CourseObject, { kind: "image" | "text" }>;
/**
 * What a knob or crop drag changes, and only that (J11 review): the rotation, or the crop with the box. The page
 * applies it to the props it shows at that moment, so an inspector edit committed during the press is kept.
 */
export type StyleChange = { patch: { rotationDeg?: number; crop?: Crop }; geometry?: course.CourseObject["geometry"] };

/** The knob's tip for `o` at `mmPerPx` (J11): above an image's top edge, or along a text's own up from its anchor. */
export function knobOf(o: StyledObject, mmPerPx: number): { from: Pt; at: Pt } {
  const stem = ROTATE_STEM_PX * mmPerPx;
  if (o.kind === "text") return { from: o.geometry[0], at: anchorKnob(o.geometry[0], o.props.rotationDeg ?? 0, stem) };
  const k = knobBase(imageRing(o.geometry, o.props.rotationDeg));
  return { from: k.at, at: { x: k.at.x + k.normal.x * stem, y: k.at.y + k.normal.y * stem } };
}

/** The pivot a knob turns about: an image's centre, a text's anchor. */
function pivotOf(o: StyledObject): Pt {
  if (o.kind === "text") return o.geometry[0];
  return { x: (o.geometry[0].x + o.geometry[1].x) / 2, y: (o.geometry[0].y + o.geometry[1].y) / 2 };
}

/** The change a knob or crop drag leaves (J11; the page puts it through `stylePatch`, so 0° and the full crop drop their keys). */
export function styleChangeOf(g: Extract<NonNullable<Gesture>, { kind: "rotate" | "crop" }>): StyleChange {
  if (g.kind === "rotate") return { patch: { rotationDeg: rotationAt(g.base.props.rotationDeg ?? 0, g.pivot, g.press, g.to, g.shift) } };
  const r = cropEdge(g.base.geometry, g.base.props, g.edge, g.to);
  return { geometry: r.geometry, patch: { crop: r.crop } };
}

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
export function objectOutline(o: course.CourseObject, selected: boolean, focused: number | null = null, cropMode = false): ToolShape[] {
  if (o.kind === "image") {
    // The box as drawn, turned (J7): the stored diagonal is not where a turned image's corners are; a corner handle each.
    const ring = imageRing(o.geometry, o.props.rotationDeg);
    const outline: ToolShape = { kind: "line", points: ring, closed: true, dashed: !selected, color: selected ? BLUE : PURPLE, testId: "editor-object-outline", data: { "object-id": String(o.id), "object-kind": o.kind } };
    if (!selected) return [outline];
    if (cropMode) {
      // Crop mode (J11): the whole graphic dashed, an edge handle per side; no corners, no knob.
      return [
        { kind: "line", points: uncroppedRing(o.geometry, o.props), closed: true, dashed: true, color: "#94a3b8", widthPx: 1, testId: "editor-object-crop-full" },
        outline,
        ...edgeHandles(ring).map((h): ToolShape => ({ kind: "handle", x: h.at.x, y: h.at.y, active: false, testId: "editor-object-crop-edge", data: { edge: h.edge } })),
      ];
    }
    const k = knobBase(ring);
    return [
      outline,
      ...ring.map((c, i): ToolShape => ({ kind: "handle", x: c.x, y: c.y, active: false, testId: "editor-object-handle", data: { index: String(i), corner: String(i) } })),
      // The knob a fixed screen distance above the top edge (J11): `lengthPx` along the box's own up.
      { kind: "grip", from: k.at, x: k.at.x + k.normal.x, y: k.at.y + k.normal.y, lengthPx: ROTATE_STEM_PX, testId: "editor-object-rotate" },
    ];
  }
  if (o.kind === "text") {
    const at = o.geometry[0];
    const up = anchorKnob(at, o.props.rotationDeg ?? 0, 1);
    return [
      { kind: "circle", x: at.x, y: at.y, rMm: 0.6, color: selected ? BLUE : PURPLE, testId: "editor-object-outline", data: { "object-id": String(o.id) } },
      ...(selected ? geometryHandles(o.geometry, focused, OBJECT_IDS) : []),
      // The knob on a stem from the anchor along the text's own up (J11; it turns about the anchor, user answer 6).
      ...(selected ? [{ kind: "grip", from: at, x: up.x, y: up.y, lengthPx: ROTATE_STEM_PX, testId: "editor-object-rotate" } as ToolShape] : []),
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
  /** J16: the object multi-selection (empty or ≥ 2 ids); its members are outlined and move together. */
  objectMulti?: readonly number[];
  /** J16: Shift/Ctrl-click on an object. */
  onToggleObject?: (id: number) => void;
  /** J16: live geometries of a group move, by id; null drops them (a cancel). */
  onObjectsDraft?: (drafts: ReadonlyMap<number, course.CourseObject["geometry"]> | null) => void;
  /** J16: a group move's one write (one undo entry). */
  onObjectsMoved?: (moves: { id: number; geometry: course.CourseObject["geometry"] }[]) => void;
  /** Live geometry while an object or a vertex is dragged (the page draws it as a draft). */
  onObjectDraft: (id: number, geometry: course.CourseObject["geometry"] | null) => void;
  onObjectMoved: (id: number, geometry: course.CourseObject["geometry"]) => void;
  onLegDoubleClick: (target: Extract<EditorTarget, { kind: "leg" }>, pt: Pt) => void;
  /** Rings of the multi-selection, radius on paper. */
  ringMm: number;
  redraw: Redraw;
  /** The selected leg (its phantom) with its bends, desktop and tablet (§6.7): handles to drag and focus. */
  leg?: LegBends | null;
  /** A selected image's corner drag keeps the box's ratio (J7; the inspector's lock); Shift inverts it, live (J11). */
  aspectLock?: boolean;
  /** The selected image is in crop mode (J11): its edges crop; its corners and knob are hidden. */
  cropMode?: boolean;
  onCropMode?: (on: boolean) => void;
  /** Live props (and a crop's box) while a knob or crop edge is dragged (J11); null drops it. */
  onObjectStyleDraft?: (id: number, change: StyleChange | null) => void;
  /** A knob or crop drag's one write (J11). */
  onObjectStyled?: (id: number, change: StyleChange) => void;
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
  /** A click on the selected leg's own line (the press that did not become a bend). */
  onPress?: (pt: Pt) => void;
  snap: (pt: Pt) => Pt;
}

/** Whether `pt` is within `reach` of the polyline `pts`. */
function onPolyline(pts: readonly Pt[], pt: Pt, reach: number): boolean {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
    const f = len > 0 ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len)) : 0;
    if (Math.hypot(pt.x - (a.x + dx * f), pt.y - (a.y + dy * f)) <= reach) return true;
  }
  return false;
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
    if (selected || obj.kind === "filter_region" || obj.kind === "toner_saver") shapes.push(...objectOutline(obj, selected, selected ? o.focusedVertex ?? null : null, selected && !!o.cropMode));
  }
  // J16: each member of the object multi-selection outlined blue (no handles: a group has none).
  for (const id of o.objectMulti ?? []) {
    const obj = o.objects.find((x) => x.id === id);
    if (!obj) continue;
    for (const sh of objectOutline(obj, false)) {
      if (sh.kind === "line" || sh.kind === "circle") shapes.push({ ...sh, dashed: false, color: BLUE, testId: "editor-object-multi-outline", data: { "object-id": String(id), "object-kind": obj.kind } });
    }
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
    // The selection is the leg itself, lit (§6.7): no ring, nothing floating over it.
    shapes.push({ kind: "line", points: legPolyline(leg.from, bends, leg.to), color: BLUE, widthPx: 3, casingPx: 3, opacity: 0.85, testId: "editor-leg-outline" });
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
      // The selected leg's own line, away from its ends' controls: a drag from here makes a bend (§6.7).
      if (leg && !p.shift && !p.ctrl && p.target?.kind !== "site" && p.target?.kind !== "object" && p.target?.kind !== "number" && !near(leg.from, p.pt, o.ringMm) && !near(leg.to, p.pt, o.ringMm)
        && onPolyline(legPolyline(leg.from, leg.bends, leg.to), p.pt, (p.touch ? 14 : 5) * p.mmPerPx)) {
        g.current = { kind: "bend-new", press: p.pt, mmPerPx: p.mmPerPx, alt: !!p.alt };
        return true;
      }
      // A finger elsewhere is the viewer's: its targets, a pan, the tap that selects an object (§10).
      if (p.touch) return false;
      const sel = shown(o);
      // J16: Shift or Ctrl on an object's body toggles it into the object multi-selection; a handle of the selected
      // object (knob, corner, crop edge, vertex, grip) keeps its own gesture.
      const toggle = (p.shift || !!p.ctrl) && p.target?.kind === "object" && !!o.onToggleObject;
      // The knob first (J11): it sits outside the box, a fixed screen distance from it, and wins over what is under it.
      if ((sel?.kind === "image" && !o.cropMode) || sel?.kind === "text") {
        if (near(knobOf(sel, p.mmPerPx).at, p.pt, reach)) {
          g.current = { kind: "rotate", id: sel.id, base: sel, pivot: pivotOf(sel), press: p.pt, to: p.pt, shift: !!p.shift, mmPerPx: p.mmPerPx, moved: false };
          return true;
        }
      }
      if (sel?.kind === "image" && o.cropMode) {
        // Crop mode (J11): the edges; the body still moves below.
        const e = edgeHandles(imageRing(sel.geometry, sel.props.rotationDeg)).find((h) => near(h.at, p.pt, reach));
        if (e) {
          g.current = { kind: "crop", id: sel.id, edge: e.edge, base: sel, to: p.pt, mmPerPx: p.mmPerPx, moved: false };
          return true;
        }
        if (!toggle && p.target?.kind === "object" && p.target.id === sel.id) {
          g.current = { kind: "object", id: sel.id, from: p.pt, to: p.pt, moved: false, vertex: null, base: sel.geometry };
          return true;
        }
      } else if (sel?.kind === "image") {
        // A selected image (J7): a corner of its turned box resizes, a press inside it (the hit-test's target) moves.
        // Its corners are not focusable, so `Delete` deletes the image.
        const corner = imageRing(sel.geometry, sel.props.rotationDeg).findIndex((c) => near(c, p.pt, reach));
        if (corner >= 0) {
          g.current = { kind: "image-corner", id: sel.id, corner, base: sel.geometry, rotationDeg: sel.props.rotationDeg ?? 0, press: p.pt, mmPerPx: p.mmPerPx, moved: false, shift: !!p.shift };
          return true;
        }
        if (!toggle && p.target?.kind === "object" && p.target.id === sel.id) {
          g.current = { kind: "object", id: sel.id, from: p.pt, to: p.pt, moved: false, vertex: null, base: sel.geometry };
          return true;
        }
      } else if (sel) {
        // Vertex, grip, then the body or within reach of its edge. A closed area's body is its outline: the hit-test
        // answers null inside it (§5), so an interior press declines and the viewer pans — the area moves by its edge
        // or a vertex (docs/bugfixes/editor-area-press-pans.md).
        const onBody = p.target?.kind === "object" && p.target.id === sel.id;
        const d = pressGeometry(sel.geometry, vertexRule(sel.kind), { pt: p.pt, reach: HANDLE_PX * p.mmPerPx, alt: p.alt, shift: p.shift }, onBody && !toggle);
        if (d && !(toggle && d.kind === "object" && d.vertex === null)) {
          g.current = { ...d, id: sel.id };
          return true;
        }
      }
      if (toggle && p.target?.kind === "object") {
        g.current = { kind: "object-toggle", id: p.target.id };
        return true;
      }
      const target = p.target;
      if (target?.kind === "object" && o.onObjectsMoved && (o.objectMulti ?? []).includes(target.id)) {
        const bases = new Map((o.objectMulti ?? []).flatMap((id) => {
          const obj = o.objects.find((x) => x.id === id);
          return obj ? [[id, obj.geometry] as const] : [];
        }));
        g.current = { kind: "group", id: target.id, bases, from: p.pt, to: p.pt, mmPerPx: p.mmPerPx, moved: false };
        return true;
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
        // An image not selected takes no press (J7): a drag pans, a click selects it (the page's map click).
        if (obj?.kind === "image") return false;
        if (obj) {
          g.current = { kind: "object", id: obj.id, from: p.pt, to: p.pt, moved: false, vertex: null, base: obj.geometry };
          o.onSelectObject(obj.id);
          return true;
        }
      }
      return false;
    },
    onPointerDrag(pt, mods) {
      let cur = g.current;
      if (cur?.kind === "bend-new" && leg) {
        if (near(cur.press, pt, 3 * cur.mmPerPx)) return;
        const made = insertBendAt(leg.from, leg.bends, leg.to, cur.press, cur.alt);
        cur = g.current = { kind: "bend", index: made.index, press: cur.press, mmPerPx: cur.mmPerPx, bends: made.bends, moved: true, alt: false };
      }
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
      } else if (cur?.kind === "group") {
        if (!cur.moved && near(cur.from, pt, 3 * cur.mmPerPx)) return;
        cur.moved = true;
        cur.to = pt;
        o.onObjectsDraft?.(groupMoved(cur));
      } else if (cur?.kind === "image-corner") {
        if (!cur.moved && near(cur.press, pt, 3 * cur.mmPerPx)) return;
        cur.moved = true;
        // Shift inverts the lock, read live (J11): pressed or let go mid-drag, the ratio follows.
        if (mods) cur.shift = mods.shift;
        o.onObjectDraft(cur.id, cornerResized(cur, pt, o.aspectLock ?? true));
      } else if (cur?.kind === "rotate" || cur?.kind === "crop") {
        const from = cur.kind === "rotate" ? cur.press : cur.to;
        if (!cur.moved && near(from, pt, 3 * cur.mmPerPx)) return;
        cur.moved = true;
        cur.to = pt;
        if (cur.kind === "rotate" && mods) cur.shift = mods.shift;
        o.onObjectStyleDraft?.(cur.id, styleChangeOf(cur));
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
      if (cur.kind === "bend-new") {
        // No drag: a click on the leg.
        if (pt) leg?.onPress?.(cur.press);
        return;
      }
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
      if (cur.kind === "image-corner") {
        // A drag writes once; a cancelled one drops its draft; a click on a corner does nothing.
        if (!cur.moved) return;
        if (!pt) return o.onObjectDraft(cur.id, null);
        return o.onObjectMoved(cur.id, cornerResized(cur, pt, o.aspectLock ?? true));
      }
      if (cur.kind === "rotate" || cur.kind === "crop") {
        // A drag writes once (geometry only with a crop); a cancelled one drops its draft; a click does nothing.
        o.redraw();
        if (!cur.moved) return;
        if (!pt) return o.onObjectStyleDraft?.(cur.id, null);
        cur.to = pt;
        return o.onObjectStyled?.(cur.id, styleChangeOf(cur));
      }
      if (cur.kind === "object-toggle") {
        if (pt) o.onToggleObject?.(cur.id);
        return;
      }
      if (cur.kind === "group") {
        // A drag writes once; a cancelled one drops its drafts; a click on a member selects that one alone.
        if (!cur.moved) return void (pt && o.onSelectObject(cur.id));
        if (!pt) return o.onObjectsDraft?.(null);
        cur.to = pt;
        return o.onObjectsMoved?.([...groupMoved(cur)].map(([id, geometry]) => ({ id, geometry })));
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
      // On the selected image itself (not a leg or control inside it): crop mode (J11).
      // A finger never (mouse only), and not on a corner handle (J11 review).
      if (sel?.kind === "image" && !o.cropMode && !p.touch && p.target?.kind === "object" && p.target.id === sel.id
        && !imageRing(sel.geometry, sel.props.rotationDeg).some((c) => near(c, p.pt, HANDLE_PX * p.mmPerPx))) return o.onCropMode?.(true);
      const inserted = sel && sel.kind !== "image" ? insertAtEdge(sel.geometry, vertexRule(sel.kind), p.pt, HANDLE_PX * p.mmPerPx, !!p.alt) : null;
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
/** A group move's geometries now: every member's base shifted by the drag (handles are offsets and stay). */
export function groupMoved(d: { bases: ReadonlyMap<number, course.CourseObject["geometry"]>; from: Pt; to: Pt }): Map<number, course.CourseObject["geometry"]> {
  const dx = d.to.x - d.from.x, dy = d.to.y - d.from.y;
  return new Map([...d.bases].map(([id, g]) => [id, g.map((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))]));
}

function gripDragged(d: Extract<Gesture, { kind: "bend-grip" }>, pt: Pt, mods?: { shift: boolean; alt: boolean }): Bend[] {
  const b = d.base[d.index];
  const h = (d.which === "out" ? b.hOut : b.hIn) ?? { x: 0, y: 0 };
  const vec = { x: h.x + pt.x - d.press.x, y: h.y + pt.y - d.press.y };
  return dragBendGrip(d.base, d.index, d.which, vec, mods?.alt ?? false, mods?.shift ?? false);
}

/** A corner drag's box: the lock XOR Shift (J11), at least 1 mm a side, the opposite corner fixed. */
function cornerResized(d: Extract<Gesture, { kind: "image-corner" }>, pt: Pt, lock: boolean): course.CourseObject["geometry"] {
  return resizeBox(d.base, d.rotationDeg, d.corner, pt, lock !== d.shift, IMAGE_MIN_MM);
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
    /** "3-47" (number and code), "Add 47" over an existing control, or the code. */
    label: string;
    /** The label is a new control's number and code, which the layer writes itself where it draws the visit. */
    labelOnLayer?: boolean;
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
    // Outside the ring, up and to the right of it (the ring is paper-sized: a fixed pixel offset lands inside it when
    // zoomed in). Where the layer writes the new control's "13-96" itself, no second label is drawn.
    const out = gh.role === "crossing_point" ? 0 : gh.radiusMm * 0.75;
    if (!(o.provisionalDrawn && gh.labelOnLayer)) shapes.push({ kind: "text", x: gh.at.x + out, y: gh.at.y + out, text: gh.label, dxPx: 6, dyPx: -6, color: PURPLE, testId: "editor-ghost-label" });
    if (gh.description) shapes.push({ kind: "text", x: gh.at.x + out, y: gh.at.y - out, text: gh.description, dxPx: 6, dyPx: 12, color: "#475569", testId: "editor-ghost-description" });
  }
  return {
    exclusive: true,
    cursor: "crosshair",
    shapes,
    onHover: o.onHover,
    // F27: the point the click (or Place) would drop — the ghost's, snapped or a reused site's centre — for the placement loupe.
    hoverPoint: gh?.at ?? null,
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

/** `hover`: the page's snapped hover (the point a click places, F27's placement loupe); `onHover` feeds it. */
export function textBinding(o: {
  onPlace: (pt: Pt) => void;
  onExit: () => void;
  snap: (pt: Pt) => Pt;
  hover: Pt | null;
  onHover: (p: ToolPointer | null) => void;
}): EditorToolBinding {
  return {
    exclusive: true,
    cursor: "text",
    onHover: o.onHover,
    hoverPoint: o.hover,
    onClick: (p) => o.onPlace(o.snap(p.pt)),
    onContextMenu: () => o.onExit(),
  };
}

// ─── I: image (J7) ────────────────────────────────────────

/**
 * `I`: with a graphic picked, a dashed ghost of the box a click places (`editor-image-ghost`, centred on the snapped
 * hover) and the click places it; with none picked a click places nothing. `hover` is the page's snapped hover
 * (F27's placement loupe reads it as for `T`); `box` gives the box at a point.
 */
export function imageBinding(o: {
  graphicId: number | null;
  box: (pt: Pt) => [Pt, Pt];
  onPlace: (pt: Pt) => void;
  onExit: () => void;
  snap: (pt: Pt) => Pt;
  hover: Pt | null;
  onHover: (p: ToolPointer | null) => void;
}): EditorToolBinding {
  const shapes: ToolShape[] = [];
  if (o.graphicId !== null && o.hover) {
    const [a, b] = o.box(o.hover);
    shapes.push({
      kind: "line", points: [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], closed: true, dashed: true, color: PURPLE,
      testId: "editor-image-ghost", data: { "graphic-id": String(o.graphicId) },
    });
  }
  return {
    exclusive: true,
    cursor: "crosshair",
    shapes,
    onHover: o.onHover,
    hoverPoint: o.graphicId !== null ? o.hover : null,
    onClick: (p) => { if (o.graphicId !== null) o.onPlace(o.snap(p.pt)); },
    onContextMenu: () => o.onExit(),
  };
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

// ─── Map mode's `V` (docs/course-editor.md §13) ─────────────────────────

/** The CSS px a click reaches a map object within (the eyedropper's, §5). */
export const MAP_HIT_PX = 6;
/** Movement past this many CSS px turns a press on the selected object into a move. */
export const MAP_DRAG_PX = 3;

/** A press on the selected map object, paper mm; `moved` once it went past `MAP_DRAG_PX`. */
export interface MapGesture { press: Pt; mmPerPx: number; moved: boolean }
export interface MapGestureRef { current: MapGesture | null }

export interface MapSelectContext {
  /** The viewer's hit-test over the effective document (`mapObjects.onHitTest`); null before the layer loaded. */
  hit: ((pt: Pt, toleranceMm: number) => Promise<readonly { ref: import("../../../map-gl/worker").MapObjectRef | null }[]>) | null;
  /** The selected object can be moved now (selected, not hidden, writable, corrections on). */
  canMove: boolean;
  /** Whether a press at `pt` is on the selected object's drawn shape. */
  pressOn: (pt: Pt, toleranceMm: number) => boolean;
  gesture: MapGestureRef;
  /** Bumped per click: an answer to an older click is dropped. */
  clickSeq: { current: number };
  /** The click's topmost object (null: empty map) and every object under it, topmost first (Tab's stack). */
  onSelect: (ref: import("../../../map-gl/worker").MapObjectRef | null, stack: import("../../../map-gl/worker").MapObjectRef[]) => void;
  /** The pointer moved the selection by this much from the press (the draft). */
  onDrag: (dxMm: number, dyMm: number) => void;
  /** The move ended here: one write. */
  onDrop: (dxMm: number, dyMm: number) => void;
  /** The move was cancelled (Escape, the pointer left) or never started: drop the draft, write nothing. */
  onCancel: () => void;
  redraw?: Redraw;
}

/**
 * Map mode's select-and-move (§13; 08 §5.3, the Map column): exclusive, so a click is the tool's and a drag pans;
 * a click asks the hit-test and selects the topmost object; a press on the selected object (its drawn shape) takes
 * the gesture and moves it, one write on release. A release without movement is a click.
 */
type MapObjectRef = import("../../../map-gl/worker").MapObjectRef;

/** A click's hit-test at `MAP_HIT_PX`: every object under it, topmost first; an answer to an older click is dropped. */
function mapHitClick(
  c: Pick<MapSelectContext, "hit" | "clickSeq">, pt: Pt, mmPerPx: number, deliver: (stack: MapObjectRef[]) => void,
): void {
  const n = ++c.clickSeq.current;
  if (!c.hit) return;
  void c.hit(pt, MAP_HIT_PX * mmPerPx).then((hits) => {
    if (n !== c.clickSeq.current) return;
    deliver(hits.flatMap((h) => (h.ref ? [h.ref] : [])));
  }, () => undefined);
}

export function mapSelectBinding(c: MapSelectContext): EditorToolBinding {
  const click = (pt: Pt, mmPerPx: number) => mapHitClick(c, pt, mmPerPx, (stack) => c.onSelect(stack[0] ?? null, stack));
  return {
    exclusive: true,
    onClick: (p) => click(p.pt, p.mmPerPx),
    onPointerDown: (p) => {
      if (!c.canMove || p.touch || !c.pressOn(p.pt, MAP_HIT_PX * p.mmPerPx)) return false;
      c.gesture.current = { press: p.pt, mmPerPx: p.mmPerPx, moved: false };
      return true;
    },
    onPointerDrag: (pt) => {
      const g = c.gesture.current;
      if (!g) return;
      if (!g.moved && Math.hypot(pt.x - g.press.x, pt.y - g.press.y) <= MAP_DRAG_PX * g.mmPerPx) return;
      g.moved = true;
      c.onDrag(pt.x - g.press.x, pt.y - g.press.y);
      c.redraw?.();
    },
    onPointerUp: (pt) => {
      const g = c.gesture.current;
      c.gesture.current = null;
      if (!g) return;
      if (pt && g.moved) c.onDrop(pt.x - g.press.x, pt.y - g.press.y);
      else {
        c.onCancel();
        if (pt) click(pt, g.mmPerPx);
      }
      c.redraw?.();
    },
  };
}

/**
 * *Join*'s pick (docs/course-editor.md §13 "Line and area operations", G10): a one-shot armed state over Map mode's
 * tools — exclusive with a crosshair; a click asks the hit-test as `V` does and hands its stack, topmost first, to
 * `onPick`; no press is taken, so a drag pans.
 */
export function mapPickBinding(c: Pick<MapSelectContext, "hit" | "clickSeq"> & { onPick: (stack: MapObjectRef[]) => void }): EditorToolBinding {
  return {
    exclusive: true,
    cursor: "crosshair",
    onClick: (p) => mapHitClick(c, p.pt, p.mmPerPx, c.onPick),
  };
}

// ─── Map mode's `N`: nodes (docs/course-editor.md §13 "Nodes", G7) ──────────

/** A ring of the selected object's nodes, paper mm (`geometry-edit.ts` `PathRing`'s vertices and closure). */
export interface MapNodeRing { vertices: readonly Vertex[]; closed: boolean }
/** A focused node: ring `ring`, vertex `index`. */
export interface MapNodeFocus { ring: number; index: number }
/** A press on a node or grip of ring `ring`; `moved` once it went past `MAP_DRAG_PX` (`drag.moved` is the geometry's). */
export interface MapNodesGesture { ring: number; drag: GeometryDrag; mmPerPx: number; moved: boolean }
export interface MapNodesGestureRef { current: MapNodesGesture | null }

export interface MapNodesContext {
  /** As `V`'s: the viewer's hit-test, the click sequence and the selection callback (a click off the path selects). */
  hit: MapSelectContext["hit"];
  clickSeq: MapSelectContext["clickSeq"];
  onSelect: MapSelectContext["onSelect"];
  /** The selected object's rings as drawn now (the draft's while there is one); null: no nodes (§13 "Nodes"). */
  rings: readonly MapNodeRing[] | null;
  /** Presses and inserts are taken (no write in flight). */
  canPress: boolean;
  /** No insert at this many nodes over the rings (`MAP_NODES_MAX`: one more and the object has no handles). */
  maxNodes?: number;
  /** A press on a node or grip was taken (the page notes the patch it was made on). */
  onPress?: () => void;
  focus: MapNodeFocus | null;
  gesture: MapNodesGestureRef;
  /** Node snapping (§13 "Snapping"): the point a dragged node lands on; null when snapping is off. */
  snap: ((pt: Pt) => Pt) | null;
  /** Ring `ring` as a drag makes it now (the draft). */
  onDraft: (ring: number, vertices: Vertex[]) => void;
  /**
   * A gesture's result: one write; `focus` the node focused after it (null: none); `pressed` when it is a press's
   * release (a drag, an Alt-click: made on the patch at `onPress`), not a double-click's insert.
   */
  onCommit: (ring: number, vertices: Vertex[], focus: number | null, pressed: boolean) => void;
  /** A drag was cancelled (Escape, the pointer left): drop the draft, write nothing. */
  onCancel: () => void;
  onFocus: (focus: MapNodeFocus | null) => void;
  redraw?: Redraw;
}

const NODE_IDS = { outline: "editor-map-node-outline", handle: "editor-map-node", grip: "editor-map-node-grip" };

/**
 * Map mode's nodes tool (§13 "Nodes"; 08 §5.3, the Map column): exclusive; the selected line's or area's nodes and
 * grips over every ring, the §7 "Editing geometry" gestures on them (`geometry-gestures.ts`, F18's smooth by default,
 * Alt sharp), node drags snapped. A press off a node or grip is not taken (the map pans); a click within reach of the
 * edge keeps the selection and drops the focus, elsewhere it selects as `V`. Each gesture is one `onCommit`.
 */
export function mapNodesBinding(c: MapNodesContext): EditorToolBinding {
  const rings = c.rings ?? [];
  const shapes: ToolShape[] = [];
  rings.forEach((ring, r) => {
    const focused = c.focus?.ring === r ? c.focus.index : null;
    for (const s of geometryHandles(ring.vertices, focused, NODE_IDS)) {
      const data = s.kind === "handle" || s.kind === "grip" ? s.data : undefined;
      shapes.push({ ...s, data: { ...data, ring: String(r), ...(s.kind === "handle" ? { focused: String(focused === Number(data?.index)) } : {}) } } as ToolShape);
    }
  });
  const onEdge = (pt: Pt, reach: number) => rings.some((ring) => ring.vertices.length > 1 && (nearestEdge(ring.vertices, ring.closed, pt)?.dist ?? Infinity) <= reach);
  const click = (pt: Pt, mmPerPx: number) => {
    const n = ++c.clickSeq.current;
    if (onEdge(pt, HANDLE_PX * mmPerPx)) return c.onFocus(null);
    if (!c.hit) return;
    void c.hit(pt, MAP_HIT_PX * mmPerPx).then((hits) => {
      if (n !== c.clickSeq.current) return;
      const stack = hits.flatMap((h) => (h.ref ? [h.ref] : []));
      // Any click that selects drops the focus, the same object again included (§13 "Nodes", "Focus").
      c.onFocus(null);
      c.onSelect(stack[0] ?? null, stack);
    }, () => undefined);
  };
  /** A node drag's end: the pointer, or where it snaps the node to (its handles follow). */
  const snapped = (g: MapNodesGesture, pt: Pt): Pt => {
    const d = g.drag;
    if (!c.snap || d.kind !== "object" || d.vertex === null) return pt;
    const v = d.base[d.vertex];
    const at = c.snap({ x: v.x + pt.x - d.from.x, y: v.y + pt.y - d.from.y });
    return { x: d.from.x + at.x - v.x, y: d.from.y + at.y - v.y };
  };
  return {
    exclusive: true,
    shapes,
    onClick: (p) => click(p.pt, p.mmPerPx),
    onPointerDown: (p) => {
      if (!c.canPress || p.touch || rings.length === 0) return false;
      const reach = HANDLE_PX * p.mmPerPx;
      // A node, then a grip, over every ring (the outline, then the holes).
      for (const [r, ring] of rings.entries()) {
        const vertex = ring.vertices.findIndex((v) => near(v, p.pt, reach));
        if (vertex < 0) continue;
        c.gesture.current = { ring: r, mmPerPx: p.mmPerPx, moved: false, drag: { kind: "object", from: p.pt, to: p.pt, moved: false, vertex, base: ring.vertices, alt: !!p.alt } };
        c.onPress?.();
        return true;
      }
      for (const [r, ring] of rings.entries()) {
        for (const [index, v] of ring.vertices.entries()) {
          const grip = gripsOf(v).find((q) => near(q.at, p.pt, reach));
          if (!grip) continue;
          c.gesture.current = { ring: r, mmPerPx: p.mmPerPx, moved: false, drag: { kind: "grip", index, which: grip.which, from: p.pt, to: p.pt, moved: false, base: ring.vertices, alt: !!p.alt, shift: p.shift } };
          c.onPress?.();
          return true;
        }
      }
      return false;
    },
    onPointerDrag: (pt, mods) => {
      const g = c.gesture.current;
      if (!g) return;
      if (!g.moved && near(g.drag.from, pt, MAP_DRAG_PX * g.mmPerPx)) return;
      g.moved = true;
      const geometry = dragGeometry(g.drag, snapped(g, pt), mods);
      if (!geometry) return;
      c.onDraft(g.ring, geometry);
      c.redraw?.();
      const d = g.drag;
      if (d.kind === "grip") return gripPoint(geometry[d.index], d.which);
      if (d.vertex !== null) return { x: geometry[d.vertex].x, y: geometry[d.vertex].y };
    },
    onPointerUp: (pt) => {
      const g = c.gesture.current;
      c.gesture.current = null;
      if (!g) return;
      c.redraw?.();
      const d = g.drag;
      const index = d.kind === "grip" ? d.index : d.vertex;
      if (!pt) return void (g.moved && c.onCancel());
      // Within the drag threshold it is a click: focus the node (Alt toggles it), a grip does nothing.
      const r = releaseGeometry(d, g.moved ? snapped(g, pt) : d.from, ringRule(rings[g.ring]));
      if (r?.kind === "commit") c.onCommit(g.ring, r.geometry, index, true);
      else if (r?.kind === "cancel") c.onCancel();
      else if (r?.kind === "focus") c.onFocus(r.index === null ? null : { ring: g.ring, index: r.index });
    },
    onDoubleClick: (p) => {
      if (!c.canPress || rings.length === 0) return;
      if (c.maxNodes !== undefined && rings.reduce((n, ring) => n + ring.vertices.length, 0) >= c.maxNodes) return;
      // The ring whose edge is nearest; on a node nothing (its press already focused it).
      const reach = HANDLE_PX * p.mmPerPx;
      let best: { r: number; dist: number } | null = null;
      rings.forEach((ring, r) => {
        const e = ring.vertices.length > 1 ? nearestEdge(ring.vertices, ring.closed, p.pt) : null;
        if (e && (!best || e.dist < best.dist)) best = { r, dist: e.dist };
      });
      const at = best as { r: number; dist: number } | null;
      if (!at) return;
      const inserted = insertAtEdge(rings[at.r].vertices, ringRule(rings[at.r]), p.pt, reach, !!p.alt);
      if (inserted) c.onCommit(at.r, inserted.geometry, inserted.index, false);
    },
  };
}

export interface TrackLayer {
  /** The visible GPS tracks (docs/map-gps-tracks.md §5.1), UI-layer paths in paper mm. */
  shapes: readonly ToolShape[];
  /** The zoom a pointer event reported (paper mm per CSS px): the layer's decimation follows it. */
  onScale: (mmPerPx: number) => void;
}

/**
 * Map mode's GPS-track reference layer on a Map-mode tool (docs/course-editor.md §13 "GPS tracks"): the tracks are
 * drawn below the tool's own shapes and never take a pointer; hover, press and click report the zoom on their way to
 * the tool, whose answers are kept. Every Map-mode binding is wrapped with it (G25; G7, G9, G27 add tools).
 */
// ─── Map mode's `T` on map lines: select a line, split it at a node (docs/course-editor.md §13 "Split tool", G32) ──

export interface MapSplitContext {
  /** As `V`'s: the viewer's hit-test, the click sequence and the selection callback. */
  hit: MapSelectContext["hit"];
  clickSeq: MapSelectContext["clickSeq"];
  onSelect: MapSelectContext["onSelect"];
  /** The selected line's nodes (its one ring), or null: nothing drawn, a click selects. */
  line: { vertices: readonly Vertex[]; closed: boolean } | null;
  /** No split while a write is in flight. */
  canSplit?: boolean;
  /** A click on node `index` of the selected line: *Split at node* there. */
  onSplit: (index: number) => void;
}

/** The nodes a line splits at (*Split at node*, §13 answer 4): every node of a loop, else all but the two ends. */
export function splitNodes(line: { vertices: readonly Vertex[]; closed: boolean }): number[] {
  const n = line.vertices.length;
  const out: number[] = [];
  for (let i = line.closed ? 0 : 1; i < (line.closed ? n : n - 1); i++) out.push(i);
  return out;
}

/**
 * `T` on map lines (G32, user 2026-11-20): the selected line's splittable nodes drawn as handles
 * (`editor-split-node`, `data-index`); a click within `HANDLE_PX` of one splits the line there (*Split at node*), any
 * other click selects as `V` does (the topmost hit), so the next line is one click away.
 */
export function mapSplitBinding(c: MapSplitContext): EditorToolBinding {
  const nodes = c.line ? splitNodes(c.line) : [];
  const shapes: ToolShape[] = nodes.map((i) => ({ kind: "handle", x: c.line!.vertices[i].x, y: c.line!.vertices[i].y, testId: "editor-split-node", data: { index: String(i) } }));
  return {
    exclusive: true,
    shapes,
    onClick: (p) => {
      if (c.line && c.canSplit !== false) {
        const reach = HANDLE_PX * p.mmPerPx;
        let best: { i: number; d: number } | null = null;
        for (const i of nodes) {
          const v = c.line.vertices[i];
          const d = Math.hypot(v.x - p.pt.x, v.y - p.pt.y);
          if (d <= reach && (!best || d < best.d)) best = { i, d };
        }
        if (best) {
          c.clickSeq.current++; // a hit-test in flight must not reselect over the split
          return c.onSplit(best.i);
        }
      }
      mapHitClick(c, p.pt, p.mmPerPx, (stack) => c.onSelect(stack[0] ?? null, stack));
    },
  };
}

/**
 * `T` whole (G32): the GPS tracks' binding (null while they are off) over the map lines' — both drawn, a click on a
 * GPS track (`hitsTrack`, the tracks tool's own rule) the tracks', any other click the lines'.
 */
export function mapTBinding(
  tracks: EditorToolBinding | null, hitsTrack: (pt: Pt, reachMm: number) => boolean, lines: EditorToolBinding, clickSeq?: { current: number },
): EditorToolBinding {
  if (!tracks) return lines;
  return {
    ...tracks,
    shapes: [...(tracks.shapes ?? []), ...(lines.shapes ?? [])],
    onClick: (p) => {
      if (!hitsTrack(p.pt, MAP_HIT_PX * p.mmPerPx)) return lines.onClick?.(p);
      // A line hit-test still in flight is dropped: it must not undo this track pick when it answers.
      if (clickSeq) clickSeq.current++;
      tracks.onClick?.(p);
    },
  };
}

export function withTrackLayer(b: EditorToolBinding, layer: TrackLayer): EditorToolBinding {
  const out: EditorToolBinding = {
    ...b,
    shapes: layer.shapes.length > 0 ? [...layer.shapes, ...(b.shapes ?? [])] : b.shapes,
    onHover: (p) => {
      if (p) layer.onScale(p.mmPerPx);
      b.onHover?.(p);
    },
  };
  if (b.onClick) {
    const onClick = b.onClick;
    out.onClick = (p) => {
      layer.onScale(p.mmPerPx);
      onClick(p);
    };
  }
  if (b.onPointerDown) {
    const onPointerDown = b.onPointerDown;
    out.onPointerDown = (p) => {
      layer.onScale(p.mmPerPx);
      return onPointerDown(p);
    };
  }
  return out;
}

// ─── Map mode's `T`: the Tracks tool (docs/course-editor.md §13 "GPS tracks: editing", G27, G30) ──────────

/** Screen spacing of the nodes drawn along a tool's track (the renderer thins to it at the current zoom). */
export const TRACK_NODE_GAP_PX = 10;
/** Around the hovered node every stored point is drawn, within this radius. */
export const TRACK_NODE_NEAR_PX = 60;

/** The hovered node: the split a click would make, and the zoom it was found at (for the nodes drawn round it). */
export type TrackHover = SplitCandidate & { mmPerPx: number };

export interface MapTracksContext {
  /** The tool's tracks (the selected, visible, ready ones), maybe none: then no nodes or handles, a click selects. */
  targets: readonly TrackToolTarget[];
  /** The visible tracks as drawn (trimmed): a click on one selects it. */
  lines: readonly { id: string; line: gpsTrack.ProjectedTrack }[];
  gesture: { current: TrackToolState };
  /** Presses are taken (no trim or split write in flight). */
  canPress?: boolean;
  /** The node under the pointer (the page keeps it, so the nodes round it are drawn); null off every node. */
  hover?: TrackHover | null;
  onHover?: (h: TrackHover | null) => void;
  /** The trim a held handle shows now (the layer draws it); null when released or cancelled. */
  onDraft: (live: { id: string; trim: gpsTrack.TrackRange } | null) => void;
  /** A handle released at another point: one write, `before` for the undo. */
  onTrim: (id: string, trim: gpsTrack.TrackRange, before: gpsTrack.TrackRange) => void;
  /** A click on a node of a tool's track: split at stored point `index`. */
  onSplit: (id: string, index: number) => void;
  /** A click on another track: it becomes the tool's track (the selection alone). */
  onSelect: (id: string) => void;
  redraw?: Redraw;
}

/**
 * Map mode's Tracks tool (§13 "GPS tracks: editing"; docs/map-gps-tracks.md §5.2): exclusive, so a drag off a handle
 * pans. On each tool's track its splittable stored points are drawn as nodes (`editor-track-nodes`, thinned to
 * `TRACK_NODE_GAP_PX` on screen, every one within `TRACK_NODE_NEAR_PX` of the hovered node), the node a click would
 * split at highlighted (`editor-track-node-hover`); its two end handles (`editor-track-handle`, at stored points
 * `trim.start` and `trim.end − 1`, drawn last) drag along its stored points, one trim write on release; a click on a
 * tool's track splits it, on another track selects it (`tools/tracks.ts`).
 */
export function mapTracksBinding(c: MapTracksContext): EditorToolBinding {
  const live = liveTrim(c.gesture.current);
  const shapes: ToolShape[] = [];
  const handles: ToolShape[] = [];
  const hover = c.hover ?? null;
  let hovered = false;
  for (const t of c.targets) {
    const trim = live?.id === t.id ? live.trim : t.trim;
    if (!live && hover?.id === t.id && hover.index > trim.start && hover.index < trim.end - 1) hovered = true;
    const data = { "track-id": t.id };
    // Splittable: two visible points left on each side (§1.2 "Split"); none while a handle is held.
    if (!live && trim.end - trim.start >= 4) {
      shapes.push({ kind: "nodes", x: t.full.x, y: t.full.y, from: trim.start + 1, to: trim.end - 2, gapPx: TRACK_NODE_GAP_PX, testId: "editor-track-nodes", data });
      if (hover?.id === t.id && hover.index > trim.start && hover.index < trim.end - 1) {
        const near = nodesNear(t.full, trim, hover.index, TRACK_NODE_NEAR_PX * hover.mmPerPx);
        shapes.push({ kind: "nodes", x: t.full.x, y: t.full.y, indices: near, testId: "editor-track-nodes-near", data });
        shapes.push({ kind: "nodes", x: t.full.x, y: t.full.y, indices: [hover.index], active: true, testId: "editor-track-node-hover", data: { ...data, index: String(hover.index) } });
      }
    }
    for (const end of ["start", "end"] as const) {
      const i = end === "start" ? trim.start : trim.end - 1;
      handles.push({ kind: "handle", x: t.full.x[i], y: t.full.y[i], active: live?.id === t.id, testId: "editor-track-handle", data: { ...data, end, index: String(i) } });
    }
  }
  shapes.push(...handles);
  /** The step's state kept, the drafted trim reported when it changed, the effect sent; whether the press was taken. */
  const apply = (r: TrackToolStep): boolean => {
    const was = liveTrim(c.gesture.current);
    c.gesture.current = r.state;
    const now = liveTrim(r.state);
    if (was?.trim.start !== now?.trim.start || was?.trim.end !== now?.trim.end) c.onDraft(now);
    const e = r.effect;
    if (e?.kind === "trim") c.onTrim(e.id, e.trim, e.before);
    else if (e?.kind === "split") {
      c.onHover?.(null);
      c.onSplit(e.id, e.index);
    } else if (e?.kind === "select") c.onSelect(e.id);
    return r.taken;
  };
  return {
    exclusive: true,
    shapes,
    cursor: hovered ? "pointer" : undefined,
    onHover: (p) => {
      if (!c.onHover) return;
      const h = p && c.gesture.current.kind === "idle" ? hoverCandidate(p.pt, MAP_HIT_PX * p.mmPerPx, c.targets, c.lines) : null;
      c.onHover(h ? { ...h, mmPerPx: p!.mmPerPx } : null);
    },
    onClick: (p) => void apply(trackToolStep(c.gesture.current, { type: "click", pt: p.pt, reachMm: MAP_HIT_PX * p.mmPerPx, targets: c.targets, lines: c.lines })),
    onPointerDown: (p) => {
      if (p.touch || c.canPress === false) return false;
      return apply(trackToolStep(c.gesture.current, { type: "down", pt: p.pt, handleMm: HANDLE_PX * p.mmPerPx, dragMm: MAP_DRAG_PX * p.mmPerPx, targets: c.targets }));
    },
    onPointerDrag: (pt) => {
      apply(trackToolStep(c.gesture.current, { type: "drag", pt }));
      c.redraw?.();
      const s = c.gesture.current;
      if (s.kind === "drag") return { x: s.target.full.x[s.index], y: s.target.full.y[s.index] };
    },
    onPointerUp: (pt) => {
      apply(trackToolStep(c.gesture.current, { type: "up", pt }));
      c.redraw?.();
    },
  };
}

// ─── Map mode's `P`, `L`, `A`: drawing (docs/course-editor.md §13 "Drawing", G9) ──────────

/** A press of `P` with an orientable symbol: placed at `at` (snapped), aimed at `to` once past `MAP_DRAG_PX`. */
export interface MapPointGesture { at: Pt; to: Pt; press: Pt; mmPerPx: number; moved: boolean }
export interface MapPointGestureRef { current: MapPointGesture | null }

export interface MapPointContext {
  /** A symbol is chosen and a write can go now. */
  canPlace: boolean;
  /** The chosen symbol turns with the object's angle (`symbols.ts` `isOrientable`): a press-drag aims it. */
  orientable: boolean;
  snap: (pt: Pt) => Pt;
  gesture: MapPointGestureRef;
  /** One point at `at`, `angle` in 0.1° (`angleOfDrag`). */
  onPlace: (at: Pt, angle: number) => void;
  /** The point being aimed (the draft). */
  onAim: (at: Pt, angle: number) => void;
  /** The aim was cancelled (Escape, the pointer left): drop the draft, place nothing. */
  onCancel: () => void;
  redraw?: Redraw;
}

/** The angle a drag from `a` to `b` sets (`angleOfDrag`, 0.1°). */
const dragAngle = (a: Pt, b: Pt): number => angleOfDrag(b.x - a.x, b.y - a.y);

/**
 * Map mode's point tool (§13 "Drawing"; 08 §5.3 "Placement flow"): exclusive, a crosshair; a click places one point
 * and the tool stays armed. With an orientable symbol a press is taken: a drag past 3 px aims the point from the press
 * (the symbol's x axis along the drag; user 2026-11-15, G9 question 3), the release places it turned, a release
 * without movement places it at 0. Otherwise a drag pans.
 */
export function mapPointBinding(c: MapPointContext): EditorToolBinding {
  const g = c.gesture.current;
  return {
    exclusive: true,
    cursor: "crosshair",
    shapes: g?.moved ? [{ kind: "line", points: [g.at, g.to], color: PURPLE, testId: "editor-map-point-direction" }] : undefined,
    onClick: (p) => {
      if (c.canPlace) c.onPlace(c.snap(p.pt), 0);
    },
    onPointerDown: (p) => {
      if (!c.canPlace || !c.orientable || p.touch) return false;
      const at = c.snap(p.pt);
      c.gesture.current = { at, to: at, press: p.pt, mmPerPx: p.mmPerPx, moved: false };
      return true;
    },
    onPointerDrag: (pt) => {
      const d = c.gesture.current;
      if (!d) return;
      if (!d.moved && Math.hypot(pt.x - d.press.x, pt.y - d.press.y) <= MAP_DRAG_PX * d.mmPerPx) return;
      d.moved = true;
      d.to = pt;
      c.onAim(d.at, dragAngle(d.at, pt));
      c.redraw?.();
    },
    onPointerUp: (pt) => {
      const d = c.gesture.current;
      c.gesture.current = null;
      if (!d) return;
      if (!pt) c.onCancel();
      else c.onPlace(d.at, d.moved ? dragAngle(d.at, pt) : 0);
      c.redraw?.();
    },
  };
}

/**
 * Map mode's line and area tools (§13 "Drawing"): the course editor's drawing flow (`areaBinding`, §6.4 and F18)
 * with the kinds `map_line` / `map_area`; a closing gesture is held back (the drawing kept) while `canClose` says a
 * write cannot go.
 */
export function mapDrawBinding(o: AreaOptions & { canClose: () => boolean }): EditorToolBinding {
  return areaBinding({ ...o, onDone: (vertices) => { if (o.canClose()) o.onDone(vertices); } });
}
