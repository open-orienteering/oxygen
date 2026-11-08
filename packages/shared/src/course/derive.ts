/**
 * The course-setting rules as geometry (docs/course-layer.md §3): which
 * sites are drawn, effective circle gaps, legs gapped and clipped at the
 * circles, number positions and the start's rotation. Paper mm, y-up.
 */

import { placeControlLabels, type PlacementCircle, type PlacementSeg } from "../course-maps/control-label-placement.js";
import { subtractLegGaps } from "../course-maps/overlay-geometry.js";
import type { MapPoint, PathVertex } from "../course-maps/schema.js";
import { bendSegmentAt, legPolylineOf } from "./bends.js";
import { circleCuts, polylineLegGaps } from "./cuts.js";
import { sectionsOf } from "./structure.js";
import type { CourseDerivation, CourseItem, CourseItemRole, CourseLayerInput, CourseSite, CourseStructure, DerivedCourse, DerivedLeg, DerivedSite, DerivedSiteRole } from "./types.js";

/** Sizes the rules read, paper mm (from the resolved symbols). */
export interface CourseMetrics {
  circleRadiusMm: number;
  finishRadiusMm: number;
  startRadiusMm: number;
  /** 704 em, the label box estimate's unit. */
  numberEmMm: number;
  /** Drawn 705 / 703 line width: automatic cuts clear its half (§3.4). */
  lineWidthMm: number;
}

/** Legs stop this many circle radii beyond a site's own extent (legacy 1.2 × R at a control). */
const CLEARANCE_EXTRA = 0.2;

const positioned = (s: CourseSite) => s.x !== 0 || s.y !== 0;

export function structuresOf(input: Pick<CourseLayerInput, "structure">): readonly CourseStructure[] {
  const s = input.structure;
  return s === null ? [] : Array.isArray(s) ? (s as readonly CourseStructure[]) : [s as CourseStructure];
}

interface SeqEntry {
  site: CourseSite;
  role: CourseItemRole;
  item: CourseItem;
}

/** The role an item takes from its site's kind: a map exchange draws as a numbered control on both its parts (§10.3, §11). */
const itemRoleOf = (kind: CourseSite["kind"]): CourseItemRole => (kind === "start" || kind === "finish" ? kind : "control");

/** Crossing and map-issue points are never items (§10.3): an item naming one is skipped. */
const isItemSite = (s: CourseSite) => s.kind !== "crossing_point" && s.kind !== "map_issue";

function sequenceOf(structure: CourseStructure, sites: ReadonlyMap<string, CourseSite>): SeqEntry[] {
  const out: SeqEntry[] = [];
  for (const item of structure.items) {
    const site = sites.get(item.siteId);
    if (!site || !positioned(site) || !isItemSite(site)) continue;
    out.push({ site, role: item.role ?? itemRoleOf(site.kind), item });
  }
  return out;
}

/**
 * A leg's bends with the crossing point it runs through (§10.3): `via`
 * joins the path [a, ...bends, b] as a corner on the segment whose
 * flattened curve is nearest it (`bendSegmentAt`), so the leg keeps its
 * order of vertices (the editor's *Add bend here* rule); the neighbours
 * keep their handles. Lengths, checks and the drawing read the same
 * flattened polyline (`legPolylineOf`).
 */
export function routedBends(a: MapPoint, bends: readonly PathVertex[] | undefined, via: MapPoint, b: MapPoint): PathVertex[] {
  const list = [...(bends ?? [])];
  list.splice(bendSegmentAt(a, list, b, via).index, 0, { x: via.x, y: via.y });
  return list;
}

/** Polyline length, mm: a leg's length along its bends (§4.1, §10.1). */
export function legLengthMm(points: readonly MapPoint[]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) {
    // sqrt(dx² + dy²), not hypot: a straight leg's stored length stays the pre-E6 formula bit for bit (§4.1).
    const dx = points[i].x - points[i - 1].x, dy = points[i].y - points[i - 1].y;
    sum += Math.sqrt(dx * dx + dy * dy);
  }
  return sum;
}

interface Obstacle {
  x: number;
  y: number;
  clearance: number;
}

/**
 * Clip a polyline at the sites (§3.2 step 3): each segment loses what lies
 * within an obstacle's clearance; what is left joins back into runs
 * through the bends, and runs of 1 mm or less are dropped. On a straight
 * piece this is `clipLine`'s rule.
 */
function clipPolyline(piece: readonly MapPoint[], obstacles: readonly Obstacle[]): MapPoint[][] {
  const runs: MapPoint[][] = [];
  let open: MapPoint[] | null = null;
  for (let j = 1; j < piece.length; j++) {
    const a = piece[j - 1], b = piece[j];
    const dx = b.x - a.x, dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;
    const ux = dx / length, uy = dy / length;
    const blocks: Array<[number, number]> = [];
    for (const o of obstacles) {
      const along = (o.x - a.x) * ux + (o.y - a.y) * uy;
      const perpendicular = Math.hypot(a.x + along * ux - o.x, a.y + along * uy - o.y);
      if (perpendicular < o.clearance) {
        const half = Math.sqrt(o.clearance * o.clearance - perpendicular * perpendicular);
        blocks.push([along - half, along + half]);
      }
    }
    blocks.sort((l, r) => l[0] - r[0]);
    const visible: Array<[number, number]> = [];
    let cursor = 0;
    for (const [start, end] of blocks) {
      if (start > cursor) visible.push([cursor, Math.min(start, length)]);
      cursor = Math.max(cursor, end);
      if (cursor >= length) break;
    }
    if (cursor < length) visible.push([cursor, length]);
    const at = (d: number): MapPoint => (d === 0 ? { x: a.x, y: a.y } : d === length ? { x: b.x, y: b.y } : { x: a.x + d * ux, y: a.y + d * uy });
    for (const [s, e] of visible) {
      if (e <= s) continue;
      if (open && s === 0) open.push(at(e));
      else {
        open = [at(s), at(e)];
        runs.push(open);
      }
      if (e < length) open = null;
    }
    if (visible.length === 0 || visible[visible.length - 1][1] < length) open = null;
  }
  return runs.filter((r) => legLengthMm(r) > 1);
}

const segmentsOf = (pts: MapPoint[]): PlacementSeg[] =>
  pts.slice(1).map((p, i) => ({ x1: pts[i].x, y1: pts[i].y, x2: p.x, y2: p.y }));

export function deriveCourse(input: CourseLayerInput, m: CourseMetrics): CourseDerivation {
  const structures = structuresOf(input);
  const siteById = new Map(input.sites.map((s) => [s.id, s]));
  const sequences = structures.map((s) => sequenceOf(s, siteById));
  // ---- one part (§11): a single structure split at its map exchanges. The numbers continue across
  // the exchange (answer 2), so the part's first number counts the controls before it.
  let part: { index: number; count: number } | undefined;
  let numberBase = 0;
  const wanted = input.viewOptions.section;
  if (wanted !== undefined && sequences.length === 1) {
    const parts = sectionsOf(sequences[0], (e) => e.site.kind === "map_exchange");
    const p = parts[wanted];
    if (parts.length >= 2 && p) {
      numberBase = sequences[0].slice(0, p.from).filter((e) => e.role === "control").length;
      sequences[0] = sequences[0].slice(p.from, p.to + 1);
      part = { index: p.index, count: parts.length };
    }
  }
  // The event's auto-cuts toggle off: no automatic slits / gaps; authored ones still apply (§3.4).
  const features = input.viewOptions.autoCuts === false ? undefined : input.cutFeatures;
  const R = m.circleRadiusMm;

  // ---- drawn sites: the courses' in first-visit order, then the crossing points their legs run
  // through (§10.3), then (all-controls) every other positioned site; setter marks add every
  // crossing and map-issue point. A map-issue point is drawn with setter marks only.
  const setterMarks = !!input.viewOptions.setterMarks;
  const drawn = new Map<string, { site: CourseSite; role: DerivedSiteRole; }>();
  for (const seq of sequences) {
    for (const e of seq) {
      if (!drawn.has(e.site.id)) drawn.set(e.site.id, { site: e.site, role: e.role });
    }
  }
  const crossingOf = (structure: CourseStructure, e: SeqEntry): CourseSite | undefined => {
    if (structure.orderMode !== "ordered") return undefined;
    const site = siteById.get(e.item.leg?.crossing?.controlId ?? "");
    return site && site.kind === "crossing_point" && positioned(site) ? site : undefined;
  };
  structures.forEach((structure, k) => {
    sequences[k].forEach((e, i) => {
      const site = i > 0 ? crossingOf(structure, e) : undefined;
      if (site && !drawn.has(site.id)) drawn.set(site.id, { site, role: "crossing_point" });
    });
  });
  const roleOfSite = (site: CourseSite): DerivedSiteRole | null =>
    site.kind === "crossing_point" ? "crossing_point" : site.kind === "map_issue" ? (setterMarks ? "map_issue" : null) : itemRoleOf(site.kind);
  for (const site of input.sites) {
    if (!positioned(site) || drawn.has(site.id)) continue;
    const marked = setterMarks && (site.kind === "crossing_point" || site.kind === "map_issue");
    const role = input.viewOptions.allControls || marked ? roleOfSite(site) : null;
    if (role) drawn.set(site.id, { site, role });
  }

  const extentOf = (role: DerivedSiteRole) => (role === "start" ? m.startRadiusMm : role === "finish" ? m.finishRadiusMm : R);
  // Crossing and map-issue points never clip a leg (§10.3): the leg runs through them.
  const isMark = (role: DerivedSiteRole) => role === "crossing_point" || role === "map_issue";
  const obstacles = [...drawn.values()].filter(({ role }) => !isMark(role)).map(({ site, role }) => ({ x: site.x, y: site.y, clearance: extentOf(role) + CLEARANCE_EXTRA * R }));

  const sites: DerivedSite[] = [...drawn.values()].map(({ site, role }) => ({
    id: site.id,
    code: site.code,
    role,
    x: site.x,
    y: site.y,
    cuts: role !== "control" ? [] : site.circleGaps && site.circleGaps.length > 0 ? [...site.circleGaps] : features ? circleCuts(features, site.x, site.y, R, m.lineWidthMm) : [],
  }));
  const derivedById = new Map(sites.map((s) => [s.id, s]));

  // ---- legs
  const courses: DerivedCourse[] = structures.map((structure, k) => {
    const seq = sequences[k];
    const legs: DerivedLeg[] = [];
    if (structure.orderMode === "ordered") {
      for (let i = 1; i < seq.length; i++) {
        const a = seq[i - 1].site, b = seq[i].site;
        const leg = seq[i].item.leg;
        const via = crossingOf(structure, seq[i]);
        const points = legPolylineOf(a, via ? routedBends(a, leg?.bends, via, b) : leg?.bends, b);
        const gaps = leg?.gaps && leg.gaps.length > 0 ? leg.gaps : (features ? polylineLegGaps(points, features, R, m.lineWidthMm) : []);
        const pieces: MapPoint[][] = [];
        for (const piece of gaps.length ? subtractLegGaps(points, gaps) : [points]) pieces.push(...clipPolyline(piece, obstacles));
        const derived: DerivedLeg = { from: a.id, to: b.id, points, style: leg?.style ?? "line", gaps, pieces };
        // §10.2: ground metres at the base map's scale; the band is paper mm already.
        const k = leg?.corridor;
        if (k) derived.corridor = { widthMm: (k.widthM * 1000) / input.document.mapScale, whiteMm: k.whiteMm, edge: k.edge };
        if (via) derived.crossing = via.id;
        legs.push(derived);
      }
    }
    const course: DerivedCourse = { id: structure.id, orderMode: structure.orderMode, sequence: seq.map((e) => ({ siteId: e.site.id, role: e.role })), legs };
    if (part) course.section = part;
    return course;
  });

  // ---- start rotation: apex towards the next site of the first ordered course that starts there.
  for (const s of sites) {
    if (s.role !== "start") continue;
    for (const c of courses) {
      if (c.orderMode !== "ordered") continue;
      const i = c.sequence.findIndex((e) => e.siteId === s.id && e.role === "start");
      const next = i >= 0 ? siteById.get(c.sequence[i + 1]?.siteId ?? "") : undefined;
      if (!next) continue;
      s.angleDeg = (Math.atan2(next.y - s.y, next.x - s.x) * 180) / Math.PI - 90;
      break;
    }
  }

  // ---- crossing points (§10.3): passage along the leg through them — the chord from the point
  // before the site to the point after — of the first ordered course whose leg names it; else
  // north–south. The section form follows that leg's `section`.
  for (const s of sites) {
    if (s.role !== "crossing_point") continue;
    s.angleDeg = 90;
    found: for (let k = 0; k < courses.length; k++) {
      for (let i = 0; i < courses[k].legs.length; i++) {
        const leg = courses[k].legs[i];
        if (leg.crossing !== s.id) continue;
        const j = leg.points.findIndex((p) => p.x === s.x && p.y === s.y);
        const before = leg.points[Math.max(0, j - 1)], after = leg.points[Math.min(leg.points.length - 1, j + 1)];
        if (before && after && (before.x !== after.x || before.y !== after.y)) s.angleDeg = (Math.atan2(after.y - before.y, after.x - before.x) * 180) / Math.PI;
        // The leg into sequence entry i + 1 carries the crossing.
        if (sequences[k][i + 1]?.item.leg?.crossing?.section) s.section = true;
        break found;
      }
    }
  }

  // ---- numbers
  const single = structures.length === 1 ? structures[0] : undefined;
  const labelMode = input.viewOptions.labelMode ?? (single?.orderMode === "ordered" && !input.viewOptions.allControls ? "sequence" : "code");
  const numbers = new Map<string, number[]>();
  if (labelMode === "sequence" && courses[0]) {
    let n = numberBase;
    for (const e of sequences[0]) {
      if (e.role !== "control") continue;
      n++;
      // A hidden visit still takes its number in the sequence; it is only not drawn.
      if (!e.item.numberHidden) numbers.set(e.site.id, [...(numbers.get(e.site.id) ?? []), n]);
    }
  }
  // Code labels: hidden when every visit of the site is (a site no hidden-visit item names is shown).
  const hiddenNumber = new Set<string>();
  if (single) {
    const visits = new Map<string, boolean>();
    for (const e of sequences[0]) if (e.role === "control") visits.set(e.site.id, (visits.get(e.site.id) ?? true) && !!e.item.numberHidden);
    for (const [id, hidden] of visits) if (hidden) hiddenNumber.add(id);
  }
  const offsets = single?.labelOffsets ?? {};
  // The placer's direction preferences are screen conventions: place in y-down, then flip back.
  // Crossing and map-issue points are no placement obstacle (§10.3).
  const circles: PlacementCircle[] = sites.filter((s) => !isMark(s.role)).map((s) => {
    const c: PlacementCircle = { id: s.id, x: s.x, y: -s.y, radius: extentOf(s.role) };
    if (s.role === "control" && !hiddenNumber.has(s.id)) {
      c.label = numbers.get(s.id)?.join("/") ?? s.code;
      const off = offsets[s.id];
      if (off) c.fixedLabel = { x: s.x + off.dx, y: -(s.y + off.dy) };
    }
    return c;
  });
  const lines: PlacementSeg[] = [];
  for (const c of courses) {
    for (const leg of c.legs) for (const piece of leg.pieces) lines.push(...segmentsOf(piece));
  }
  const placed = placeControlLabels(circles, lines.map((l) => ({ x1: l.x1, y1: -l.y1, x2: l.x2, y2: -l.y2 })), { radius: R, labelSize: m.numberEmMm });
  for (const c of circles) {
    const p = placed.get(c.id);
    const s = derivedById.get(c.id);
    if (!p || !s || c.label === undefined) continue;
    s.label = { text: c.label, x: p.x, y: -p.y, ...(p.leader ? { leader: { x1: p.leader.x1, y1: -p.leader.y1, x2: p.leader.x2, y2: -p.leader.y2 } } : {}), ...(p.collides ? { collides: true as const } : {}) };
  }

  return { sites, courses };
}
