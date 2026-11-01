/**
 * The course-setting rules as geometry (docs/course-layer.md §3): which
 * sites are drawn, effective circle gaps, legs gapped and clipped at the
 * circles, number positions and the start's rotation. Paper mm, y-up.
 */

import { placeControlLabels, type PlacementCircle, type PlacementSeg } from "../course-maps/control-label-placement.js";
import { clipLine, subtractLegGaps, type OverlaySegment } from "../course-maps/overlay-geometry.js";
import type { MapPoint } from "../course-maps/schema.js";
import { circleCuts, legGaps } from "./cuts.js";
import type { CourseDerivation, CourseItem, CourseLayerInput, CourseSite, CourseStructure, DerivedCourse, DerivedLeg, DerivedSite } from "./types.js";

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
  role: CourseSite["kind"];
  item: CourseItem;
}

function sequenceOf(structure: CourseStructure, sites: ReadonlyMap<string, CourseSite>): SeqEntry[] {
  const out: SeqEntry[] = [];
  for (const item of structure.items) {
    const site = sites.get(item.siteId);
    if (!site || !positioned(site)) continue;
    out.push({ site, role: item.role ?? site.kind, item });
  }
  return out;
}

/** Join clipped segments that share an end point back into polylines. */
function joinSegments(segments: OverlaySegment[]): MapPoint[][] {
  const out: MapPoint[][] = [];
  for (const s of segments) {
    const last = out.at(-1)?.at(-1);
    if (last && Math.abs(last.x - s.x1) < 1e-9 && Math.abs(last.y - s.y1) < 1e-9) out.at(-1)!.push({ x: s.x2, y: s.y2 });
    else out.push([{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }]);
  }
  return out;
}

const segmentsOf = (pts: MapPoint[]): PlacementSeg[] =>
  pts.slice(1).map((p, i) => ({ x1: pts[i].x, y1: pts[i].y, x2: p.x, y2: p.y }));

export function deriveCourse(input: CourseLayerInput, m: CourseMetrics): CourseDerivation {
  const structures = structuresOf(input);
  const siteById = new Map(input.sites.map((s) => [s.id, s]));
  const sequences = structures.map((s) => sequenceOf(s, siteById));
  const features = input.cutFeatures;
  const R = m.circleRadiusMm;

  // ---- drawn sites: the courses' in first-visit order, then (all-controls) every other positioned site.
  const drawn = new Map<string, { site: CourseSite; role: CourseSite["kind"]; }>();
  for (const seq of sequences) {
    for (const e of seq) {
      if (!drawn.has(e.site.id)) drawn.set(e.site.id, { site: e.site, role: e.role });
    }
  }
  if (input.viewOptions.allControls) {
    for (const site of input.sites) if (positioned(site) && !drawn.has(site.id)) drawn.set(site.id, { site, role: site.kind });
  }

  const extentOf = (role: CourseSite["kind"]) => (role === "start" ? m.startRadiusMm : role === "finish" ? m.finishRadiusMm : R);
  const obstacles = [...drawn.values()].map(({ site, role }) => ({ x: site.x, y: site.y, clearance: extentOf(role) + CLEARANCE_EXTRA * R }));

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
        const points = [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
        const gaps = leg?.gaps && leg.gaps.length > 0 ? leg.gaps : (features ? legGaps(points[0], points[1], features, R, m.lineWidthMm) : []);
        const pieces: MapPoint[][] = [];
        for (const piece of gaps.length ? subtractLegGaps(points, gaps) : [points]) {
          const segs: OverlaySegment[] = [];
          for (let j = 1; j < piece.length; j++) segs.push(...clipLine(piece[j - 1], piece[j], obstacles, CLEARANCE_EXTRA * R + R));
          pieces.push(...joinSegments(segs));
        }
        legs.push({ from: a.id, to: b.id, points, gaps, pieces });
      }
    }
    return { id: structure.id, orderMode: structure.orderMode, sequence: seq.map((e) => ({ siteId: e.site.id, role: e.role })), legs };
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

  // ---- numbers
  const single = structures.length === 1 ? structures[0] : undefined;
  const labelMode = input.viewOptions.labelMode ?? (single?.orderMode === "ordered" && !input.viewOptions.allControls ? "sequence" : "code");
  const numbers = new Map<string, number[]>();
  if (labelMode === "sequence" && courses[0]) {
    let n = 0;
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
  const circles: PlacementCircle[] = sites.map((s) => {
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
    s.label = { text: c.label, x: p.x, y: -p.y, ...(p.leader ? { leader: { x1: p.leader.x1, y1: -p.leader.y1, x2: p.leader.x2, y2: -p.leader.y2 } } : {}) };
  }

  return { sites, courses };
}
