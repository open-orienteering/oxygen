/**
 * Advisory course-setting checks (docs/course-layer.md §9; 08 §4.2,
 * §5.6): IOF distance and code rules over the event's sites, and per
 * course the sheet, number, description and leg rules. Pure and
 * deterministic; paper mm, y-up. Nothing here blocks a save.
 */

import type { MapPoint, MapWindow } from "../course-maps/schema.js";
import { pointInWindow } from "../course-maps/geometry.js";
import { OBJECT_TYPE } from "../map-document/header.js";
import type { EffectiveDocument } from "../map-document/patch.js";
import { isAppliedMatch } from "../map-document/render-bridge.js";
import { COORD_FLAG } from "../render/pass-stream.js";
import type { SymbolLibraryId } from "../symbol-library/index.js";
import { courseDocumentContext } from "./context.js";
import { legPolylineOf } from "./bends.js";
import { legLengthMm, routedBends } from "./derive.js";
import { sectionsOf } from "./structure.js";
import type { CourseLayerObject } from "./objects.js";
import type { CourseDerivation, CourseLegProps, CourseStructure } from "./types.js";

/**
 * The codes in output order (§9.2). `DESCRIPTION_STALE` is the server's
 * (`course.checks`); the two `VARIATION_*` codes the editor's (they read
 * `groups`, which `course.checks` does not pass — §9.4).
 */
export const COURSE_CHECK_CODES = [
  "CONTROL_TOO_CLOSE",
  "SAME_FEATURE_TOO_CLOSE",
  "CODE_BELOW_31",
  "CODE_DUPLICATE",
  "CODE_INVERTIBLE",
  "CONTROL_OUTSIDE_SHEET",
  "EXCHANGE_WITHOUT_SHEET",
  "NUMBER_UNPLACED",
  "NUMBER_OVERLAPS",
  "DESCRIPTION_MISSING",
  "DESCRIPTION_STALE",
  "LEG_CROSSES_OOB",
  "LEG_THROUGH_UNCROSSABLE",
  "VARIATION_UNBALANCED",
  "VARIATION_ALL_EMPTY",
] as const;
export type CourseCheckCode = (typeof COURSE_CHECK_CODES)[number];

/** IOF minimum distance between controls, metres (sprint: 15). */
export const CONTROL_MIN_DISTANCE_M = 30;
export const SPRINT_CONTROL_MIN_DISTANCE_M = 15;
/** Same column-D feature closer than this, metres. */
export const SAME_FEATURE_MIN_DISTANCE_M = 60;
/** Without a document: a map at this scale or larger counts as sprint. */
const SPRINT_SCALE_MAX = 5000;
const MIN_CODE = 31;

/** Uncrossable line and area features, by ISOM 2017-2 / ISSprOM 2019-2 code (§9.2). */
export const UNCROSSABLE_CODES: ReadonlySet<number> = new Set([201, 301, 307, 411, 515, 518, 520, 521, 529]);
/** Out-of-bounds boundary and area (708, 709). */
export const OOB_CODES: ReadonlySet<number> = new Set([708, 709]);
/**
 * A leg through a crossing point (§10.3) is exempt at an obstacle whose
 * line (an area's ring closed) comes within this of the site, paper mm:
 * the crossing is where the leg passes it (§9.3).
 */
export const CROSSING_REACH_MM = 1.0;
/** `VARIATION_UNBALANCED` (08 §5.6): the alternatives' lengths differ by more than this share of the longest. */
export const VARIATION_BALANCE_TOLERANCE = 0.1;

export interface CourseCheck {
  code: CourseCheckCode;
  /** The sites involved, in input order; a leg check names its two ends. */
  siteIds: string[];
  /** A leg check: its ends and its index in the course's positioned sequence. */
  leg?: { from: string; to: string; index: number };
  /** Where to locate and mark it, paper mm. */
  at: MapPoint;
  /** What the message shows (`distanceM`, `limitM`, codes, `symbol`). */
  params?: Record<string, string | number>;
}

/** A site as the checks read it: one `controls` row. */
export interface CheckSite {
  id: string;
  /** Display code. */
  code: string;
  /** Punch codes. */
  codes: readonly number[];
  kind: string;
  /** `x = y = 0` is unpositioned (§3.3). */
  x: number;
  y: number;
  description?: { d?: string } | null;
}

/** A line or area of the base map a leg must not cross (§9.3). */
export interface CheckObstacle {
  kind: "oob" | "uncrossable";
  /** The symbol code (`709`, `521.1`, …). */
  code: string;
  closed: boolean;
  /** On-curve vertices, paper mm. */
  points: MapPoint[];
}

export interface CheckDocument {
  libraryId: SymbolLibraryId;
  obstacles: readonly CheckObstacle[];
}

/**
 * A sheet window as the checks read it: `section` is the part of a course
 * split by map exchanges the sheet prints (§11; `course_maps.section_index`).
 * Absent, the window stands for every part.
 */
export type CheckSheet = MapWindow & { section?: number };

export interface CourseChecksInput {
  /** The course checked; null = the event-wide codes only. */
  structure: CourseStructure | null;
  /** Every site of the event. */
  sites: readonly CheckSite[];
  document: CheckDocument | null;
  /** The course's sheet windows; null or empty skips `CONTROL_OUTSIDE_SHEET` and `EXCHANGE_WITHOUT_SHEET`. */
  sheets: readonly CheckSheet[] | null;
  /** Course objects in scope: `oob_area` and 708 `oob_line` are obstacles. */
  objects?: readonly CourseLayerObject[];
  /** The layer's derivation of this course; absent skips `NUMBER_*`. */
  derivation?: CourseDerivation | null;
  /** Map scale denominator; null skips the distance checks. */
  mapScale: number | null;
  /** The course's variation groups (§9.2 `VARIATION_*`; the editor's, course-editor.md §12); absent = none. */
  groups?: readonly CheckVariationGroup[];
}

/**
 * A variation group as the checks read it (§9.2): the control before it
 * (`anchor`), the item after it (`next`) and the alternatives' items with
 * the legs into them; `exitLeg` is the leg into `next`, every alternative's.
 */
export interface CheckVariationGroup {
  id: string;
  anchor: string;
  next: string;
  loop: boolean;
  alternatives: { label: string; items: { siteId: string; leg?: CourseLegProps }[] }[];
  exitLeg?: CourseLegProps;
}

const positioned = (s: { x: number; y: number }) => s.x !== 0 || s.y !== 0;
const codeNumber = (code: string): number => parseInt(code, 10);
const midpoint = (a: MapPoint, b: MapPoint): MapPoint => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const round1 = (v: number) => Math.round(v * 10) / 10;

/** The code a number reads as upside down, or null (a digit with no 180° reading, or a leading zero). */
export function invertedCode(code: number): number | null {
  const flip: Record<string, string> = { "0": "0", "1": "1", "6": "9", "8": "8", "9": "6" };
  let out = "";
  for (const ch of String(code)) {
    const f = flip[ch];
    if (f === undefined) return null;
    out = f + out;
  }
  return out.startsWith("0") ? null : Number(out);
}

/**
 * The obstacles of a pinned document (§9.3): line and area objects whose
 * symbol — the applied match's code, else the source code — is
 * uncrossable or out of bounds; on-curve vertices, an area's outer ring.
 * Reads an effective document (docs/map-patches.md §2.4): objects the
 * patch hides are skipped.
 */
export function checkObstaclesOfDocument(doc: Pick<EffectiveDocument, "header" | "attrs" | "coords" | "flags" | "coordStart" | "hidden">): CheckDocument {
  const { header, attrs, coords, flags, coordStart, hidden } = doc;
  const ctx = courseDocumentContext(header);
  const kinds = header.symbols.map((s): { kind: CheckObstacle["kind"]; code: string } | null => {
    if (s.hidden) return null;
    const code = isAppliedMatch(s.match) ? s.match!.canonicalId!.slice(s.match!.canonicalId!.indexOf(":") + 1) : s.code;
    const n = codeNumber(code);
    if (UNCROSSABLE_CODES.has(n)) return { kind: "uncrossable", code };
    if (OOB_CODES.has(n)) return { kind: "oob", code };
    return null;
  });
  const u = header.unitsPerMm;
  const obstacles: CheckObstacle[] = [];
  for (let i = 0; i < attrs.symbolIdx.length; i++) {
    const type = attrs.type[i];
    if ((type !== OBJECT_TYPE.line && type !== OBJECT_TYPE.area) || hidden?.[i]) continue;
    const k = kinds[attrs.symbolIdx[i]];
    if (!k) continue;
    const points: MapPoint[] = [];
    for (let j = coordStart[i]; j < coordStart[i + 1]; j++) {
      if (type === OBJECT_TYPE.area && j > coordStart[i] && flags[j] & COORD_FLAG.hole) break;
      if (flags[j] & (COORD_FLAG.bezierFirst | COORD_FLAG.bezierSecond)) continue;
      points.push({ x: coords[j * 2] / u, y: coords[j * 2 + 1] / u });
    }
    if (points.length >= 2) obstacles.push({ ...k, closed: type === OBJECT_TYPE.area, points });
  }
  return { libraryId: ctx.libraryId, obstacles };
}

/** Course objects that act as out-of-bounds obstacles. */
function objectObstacles(objects: readonly CourseLayerObject[]): CheckObstacle[] {
  const out: CheckObstacle[] = [];
  for (const o of objects) {
    const points = o.geometry.map((v) => ({ x: v.x, y: v.y }));
    if (o.kind === "oob_area" && points.length >= 3) out.push({ kind: "oob", code: "709", closed: true, points });
    else if (o.kind === "oob_line" && (o.props.symbol ?? "708") === "708" && points.length >= 2) out.push({ kind: "oob", code: "708", closed: false, points });
  }
  return out;
}

/** Parameter t ∈ [0, 1] along a→b where it meets c→d, or null. */
function segmentHit(a: MapPoint, b: MapPoint, c: MapPoint, d: MapPoint): number | null {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = c.x - a.x, qy = c.y - a.y;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

function insideRing(p: MapPoint, ring: readonly MapPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

interface Box { minX: number; minY: number; maxX: number; maxY: number }
const boxOf = (pts: readonly MapPoint[]): Box => {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of pts) {
    b.minX = Math.min(b.minX, p.x); b.minY = Math.min(b.minY, p.y);
    b.maxX = Math.max(b.maxX, p.x); b.maxY = Math.max(b.maxY, p.y);
  }
  return b;
};
const boxesMeet = (a: Box, b: Box) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

/** Where leg a→b first meets the obstacle (its first crossing, else the midpoint when it runs inside an area), or null. */
function legHit(a: MapPoint, b: MapPoint, o: CheckObstacle): MapPoint | null {
  const pts = o.points;
  const n = o.closed ? pts.length : pts.length - 1;
  let best: number | null = null;
  for (let i = 0; i < n; i++) {
    const t = segmentHit(a, b, pts[i], pts[(i + 1) % pts.length]);
    if (t !== null && (best === null || t < best)) best = t;
  }
  if (best !== null) return { x: a.x + (b.x - a.x) * best, y: a.y + (b.y - a.y) * best };
  const mid = midpoint(a, b);
  return o.closed && insideRing(mid, pts) ? mid : null;
}

/** Distance from `p` to the obstacle's polyline (its ring closed for an area), mm. */
function obstacleDistance(p: MapPoint, o: CheckObstacle): number {
  const pts = o.points;
  const n = o.closed ? pts.length : pts.length - 1;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}

const descriptionD = (s: CheckSite) => s.description?.d?.trim() || "";

/** The advisory checks of a course and its event's sites (docs/course-layer.md §9). */
export function courseChecks(input: CourseChecksInput): CourseCheck[] {
  const out: CourseCheck[] = [];
  const siteById = new Map(input.sites.map((s) => [s.id, s]));
  const controls = input.sites.filter((s) => s.kind === "control" && positioned(s));

  // ---- distances (event)
  if (input.mapScale && input.mapScale > 0) {
    const sprint = input.document ? input.document.libraryId === "ISSprOM2019-2" : input.mapScale <= SPRINT_SCALE_MAX;
    const limit = sprint ? SPRINT_CONTROL_MIN_DISTANCE_M : CONTROL_MIN_DISTANCE_M;
    const m = input.mapScale / 1000;
    for (let i = 0; i < controls.length; i++) {
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i], b = controls[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y) * m;
        const at = midpoint(a, b);
        if (d < limit) out.push({ code: "CONTROL_TOO_CLOSE", siteIds: [a.id, b.id], at, params: { a: a.code, b: b.code, distanceM: round1(d), limitM: limit } });
        const feature = descriptionD(a);
        if (feature && feature === descriptionD(b) && d < SAME_FEATURE_MIN_DISTANCE_M) {
          out.push({ code: "SAME_FEATURE_TOO_CLOSE", siteIds: [a.id, b.id], at, params: { a: a.code, b: b.code, distanceM: round1(d), limitM: SAME_FEATURE_MIN_DISTANCE_M, feature } });
        }
      }
    }
  }

  // ---- codes (event)
  const sitesByCode = new Map<number, CheckSite[]>();
  for (const s of input.sites) {
    for (const c of new Set(s.codes)) {
      if (!Number.isFinite(c)) continue;
      sitesByCode.set(c, [...(sitesByCode.get(c) ?? []), s]);
      if (s.kind === "control" && c < MIN_CODE) out.push({ code: "CODE_BELOW_31", siteIds: [s.id], at: { x: s.x, y: s.y }, params: { code: c } });
    }
  }
  const usedCodes = [...sitesByCode.keys()].sort((a, b) => a - b);
  const pointOf = (sites: readonly CheckSite[]): MapPoint => {
    const p = sites.find(positioned) ?? sites[0];
    return { x: p.x, y: p.y };
  };
  const ids = (sites: readonly CheckSite[]) => [...new Set(sites.map((s) => s.id))];
  for (const c of usedCodes) {
    const holders = sitesByCode.get(c)!;
    if (holders.length > 1) out.push({ code: "CODE_DUPLICATE", siteIds: ids(holders), at: pointOf(holders), params: { code: c } });
  }
  for (const c of usedCodes) {
    const inv = invertedCode(c);
    if (inv === null || inv <= c || !sitesByCode.has(inv)) continue;
    const holders = [...sitesByCode.get(c)!, ...sitesByCode.get(inv)!];
    out.push({ code: "CODE_INVERTIBLE", siteIds: ids(holders), at: pointOf(holders), params: { a: c, b: inv } });
  }

  // ---- the course
  const structure = input.structure;
  if (structure) {
    const visits = structure.items
      .map((item) => ({ item, site: siteById.get(item.siteId) }))
      .filter((v): v is { item: (typeof structure.items)[number]; site: CheckSite } => v.site !== undefined);
    // A map exchange is a numbered control on both its parts (§11).
    const roleOf = (v: (typeof visits)[number]) => v.item.role ?? (v.site.kind === "map_exchange" ? "control" : v.site.kind);
    const once = <T extends { site: CheckSite }>(list: T[]) => {
      const seen = new Set<string>();
      return list.filter((v) => !seen.has(v.site.id) && seen.add(v.site.id));
    };
    const siteCheck = (code: CourseCheckCode, s: CheckSite) => out.push({ code, siteIds: [s.id], at: { x: s.x, y: s.y }, params: { code: s.code } });

    if (input.sheets && input.sheets.length > 0) {
      const sheets = input.sheets;
      // The parts (§11) over the drawn sequence; one part when the course has no exchange.
      const drawnVisits = visits.filter((v) => positioned(v.site) && v.site.kind !== "crossing_point" && v.site.kind !== "map_issue");
      const parts = sectionsOf(drawnVisits, (v) => v.site.kind === "map_exchange");
      const covers = (w: CheckSheet, part: number) => parts.length < 2 || w.section === undefined || w.section === part;
      const outside = new Set<string>();
      drawnVisits.forEach((v, i) => {
        const own = parts.filter((p) => p.from <= i && i <= p.to);
        if (!sheets.some((w) => own.some((p) => covers(w, p.index)) && pointInWindow(v.site, w))) outside.add(v.site.id);
      });
      for (const { site } of once(visits.filter((v) => positioned(v.site)))) {
        if (outside.has(site.id)) siteCheck("CONTROL_OUTSIDE_SHEET", site);
      }
      if (parts.length >= 2) {
        for (const p of parts) {
          if (sheets.some((w) => covers(w, p.index))) continue;
          const exchange = drawnVisits[p.index === 0 ? p.to : p.from].site;
          out.push({ code: "EXCHANGE_WITHOUT_SHEET", siteIds: [exchange.id], at: { x: exchange.x, y: exchange.y }, params: { part: p.index + 1, code: exchange.code } });
        }
      }
    }

    if (input.derivation) {
      const derived = new Map(input.derivation.sites.map((s) => [s.id, s]));
      // One part drawn (§11): the numbers of that part's visits only.
      const course = input.derivation.courses[0];
      const inPart = course?.section ? new Set(course.sequence.map((e) => e.siteId)) : null;
      const controlVisits = visits.filter((v) => roleOf(v) === "control" && (!inPart || inPart.has(v.site.id)));
      for (const { site } of once(controlVisits.filter((v) => !v.item.numberHidden))) {
        if (!derived.get(site.id)?.label) siteCheck("NUMBER_UNPLACED", site);
      }
      for (const { site } of once(controlVisits)) {
        if (derived.get(site.id)?.label?.collides) siteCheck("NUMBER_OVERLAPS", site);
      }
    }

    for (const { site } of once(visits.filter((v) => roleOf(v) === "control"))) {
      if (!descriptionD(site)) siteCheck("DESCRIPTION_MISSING", site);
    }

    if (structure.orderMode === "ordered") {
      const obstacles = [...(input.document?.obstacles ?? []), ...objectObstacles(input.objects ?? [])];
      const boxes = obstacles.map((o) => boxOf(o.points));
      // Crossing and map-issue points are never items (§10.3): the layer skips them, so do the legs.
      const seqVisits = visits.filter((v) => positioned(v.site) && v.site.kind !== "crossing_point" && v.site.kind !== "map_issue");
      const seq = seqVisits.map((v) => v.site);
      for (let i = 1; i < seq.length; i++) {
        const a = seq[i - 1], b = seq[i];
        // The leg as drawn (§10.1, §10.3): along its flattened bends and its crossing point, first hit by distance along them.
        const legProps = seqVisits[i].item.leg;
        const via = siteById.get(legProps?.crossing?.controlId ?? "");
        const crossing = via && via.kind === "crossing_point" && positioned(via) ? via : undefined;
        const pts: MapPoint[] = legPolylineOf(a, crossing ? routedBends(a, legProps?.bends, crossing, b) : legProps?.bends, b);
        const legBox = boxOf(pts);
        const leg = { from: a.id, to: b.id, index: i - 1 };
        for (const kind of ["oob", "uncrossable"] as const) {
          let first: { at: MapPoint; t: number; code: string } | null = null;
          obstacles.forEach((o, k) => {
            if (o.kind !== kind || !boxesMeet(legBox, boxes[k])) return;
            // The obstacle the leg crosses at its crossing point is exempt (§9.3); others still report.
            if (crossing && obstacleDistance(crossing, o) <= CROSSING_REACH_MM) return;
            let start = 0;
            for (let j = 1; j < pts.length; j++) {
              const p = pts[j - 1], q = pts[j];
              const at = legHit(p, q, o);
              if (at) {
                const t = start + Math.hypot(at.x - p.x, at.y - p.y);
                if (!first || t < first.t) first = { at, t, code: o.code };
                break;
              }
              start += Math.hypot(q.x - p.x, q.y - p.y);
            }
          });
          if (!first) continue;
          const hit = first as { at: MapPoint; t: number; code: string };
          out.push({
            code: kind === "oob" ? "LEG_CROSSES_OOB" : "LEG_THROUGH_UNCROSSABLE",
            siteIds: [a.id, b.id], leg, at: hit.at,
            params: { from: a.code, to: b.code, symbol: hit.code },
          });
        }
      }
    }
  }

  for (const g of input.groups ?? []) out.push(...variationChecks(g, siteById, input.mapScale));

  const rank = new Map<string, number>(COURSE_CHECK_CODES.map((c, i) => [c, i]));
  return out
    .map((c, i) => ({ c, i }))
    .sort((p, q) => rank.get(p.c.code)! - rank.get(q.c.code)! || p.i - q.i)
    .map((p) => p.c);
}

/**
 * A group's checks (§9.2; 08 §5.6): `VARIATION_ALL_EMPTY` while no
 * alternative holds a control (valid, but every variant is the same
 * straight leg), else `VARIATION_UNBALANCED` when the alternatives' lengths
 * differ by more than `VARIATION_BALANCE_TOLERANCE` of the longest. An
 * alternative is measured anchor → its controls → the next item along
 * bends and crossing points (an empty one: the straight leg); in a loop
 * each petal back to the anchor, empty petals not counted. At the anchor.
 */
function variationChecks(g: CheckVariationGroup, siteById: ReadonlyMap<string, CheckSite>, mapScale: number | null): CourseCheck[] {
  const anchor = siteById.get(g.anchor);
  if (!anchor || !positioned(anchor)) return [];
  const at = { x: anchor.x, y: anchor.y };
  if (g.alternatives.every((a) => a.items.length === 0)) {
    return [{ code: "VARIATION_ALL_EMPTY", siteIds: [anchor.id], at, params: { code: anchor.code } }];
  }
  const end = g.loop ? anchor : siteById.get(g.next);
  if (!end || !positioned(end)) return [];
  const lengths: { label: string; mm: number }[] = [];
  for (const alt of g.alternatives) {
    if (g.loop && alt.items.length === 0) continue;
    const hops: { site: CheckSite; leg?: CourseLegProps }[] = [{ site: anchor }];
    for (const item of alt.items) {
      const s = siteById.get(item.siteId);
      if (s && positioned(s) && s.kind !== "crossing_point" && s.kind !== "map_issue") hops.push({ site: s, leg: item.leg });
    }
    hops.push({ site: end, leg: g.loop ? undefined : g.exitLeg });
    let mm = 0;
    for (let i = 1; i < hops.length; i++) {
      const a = hops[i - 1].site, b = hops[i].site, leg = hops[i].leg;
      const via = siteById.get(leg?.crossing?.controlId ?? "");
      const crossing = via && via.kind === "crossing_point" && positioned(via) ? via : undefined;
      mm += legLengthMm(legPolylineOf(a, crossing ? routedBends(a, leg?.bends, crossing, b) : leg?.bends, b));
    }
    lengths.push({ label: alt.label, mm });
  }
  if (lengths.length < 2) return [];
  const short = lengths.reduce((p, q) => (q.mm < p.mm ? q : p));
  const long = lengths.reduce((p, q) => (q.mm > p.mm ? q : p));
  if (long.mm <= 0 || (long.mm - short.mm) / long.mm <= VARIATION_BALANCE_TOLERANCE) return [];
  // Ground metres with a scale, else paper mm.
  const m = (mm: number) => (mapScale ? Math.round((mm * mapScale) / 1000) : Math.round(mm * 10) / 10);
  return [{
    code: "VARIATION_UNBALANCED",
    siteIds: [anchor.id],
    at,
    params: { a: short.label, b: long.label, lengthA: m(short.mm), lengthB: m(long.mm), diffPct: Math.round(((long.mm - short.mm) / long.mm) * 100), unit: mapScale ? "m" : "mm" },
  }];
}
