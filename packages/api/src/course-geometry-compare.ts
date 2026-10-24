/**
 * Old vs new `courses.geometry`, cut by cut (docs/course-layer.md §4
 * "Comparison"; research 09 §5, §10). Pure: the report script
 * (`scripts/compare-course-geometry.ts`) feeds it stored rows and what
 * `rebuildCourseGeometry` would write now.
 *
 * - Editor courses: stored vs regenerated, per control circle and per leg —
 *   the effect of the course layer and the size-aware cuts.
 * - Imported (`ocd` / `xml`) courses: how much of the file-authored
 *   geometry structure v1 carries without per-leg input — bent legs, the
 *   authored circle cuts against the automatic ones, course-level
 *   features — the "legacy-geometry fidelity" input to slice D's
 *   `LegProps.path` decision (09 §10).
 */

import { course } from "@oxygen/shared";

type Gap = { start: number; end: number } | { from: number; to: number };

interface FeatureLike {
  geometry?: { type: string; coordinates: unknown } | null;
  properties?: Record<string, unknown> | null;
}

export interface GeometryLike {
  features: FeatureLike[];
}

export type DiffStatus = "same" | "changed" | "added" | "removed";

export interface GapDiff {
  /** Control code, or `from→to` (with `#n` for a repeated leg). */
  key: string;
  status: Exclude<DiffStatus, "same">;
  old: Gap[];
  new: Gap[];
  /** Total opened: degrees for a circle, mm for a leg. */
  oldWidth: number;
  newWidth: number;
}

export interface EditorComparison {
  /** Point / leg order or positions that differ: a stale row. Its moved controls and their legs are not compared, and `reportTotals` leaves stale rows out of the cut totals. */
  structure: string[];
  circles: { compared: number; same: number; diffs: GapDiff[] };
  legs: { compared: number; same: number; diffs: GapDiff[] };
}

/** Gaps equal to this tolerance (degrees / leg fractions) are the same. */
const EPS = 1e-6;
/** A preclipped piece farther than this from the centre line is a bend, mm. */
const BEND_MM = 0.1;

const props = (f: FeatureLike) => f.properties ?? {};
const gapsOf = (v: unknown): Gap[] => (Array.isArray(v) ? (v as Gap[]) : []);
const circleWidth = (gs: Gap[]) => gs.reduce((s, g) => s + ((("end" in g ? g.end : 0) - ("start" in g ? g.start : 0) + 360) % 360), 0);
const legWidth = (gs: Gap[], lenMm: number) => gs.reduce((s, g) => s + (("to" in g ? g.to : 0) - ("from" in g ? g.from : 0)) * lenMm, 0);

function sameGaps(a: Gap[], b: Gap[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((g, i) => {
    const h = b[i] as Record<string, number>;
    return Object.entries(g).every(([k, v]) => Math.abs(v - h[k]) <= EPS);
  });
}

function statusOf(a: Gap[], b: Gap[]): DiffStatus {
  if (sameGaps(a, b)) return "same";
  return a.length === 0 ? "added" : b.length === 0 ? "removed" : "changed";
}

function pointsOf(g: GeometryLike) {
  return g.features.filter((f) => f.geometry?.type === "Point").map((f) => ({ code: String(props(f).code), type: String(props(f).symbolType), xy: f.geometry!.coordinates as [number, number], cuts: gapsOf(props(f).cuts) }));
}

function legsOf(g: GeometryLike) {
  const seen = new Map<string, number>();
  return g.features
    .filter((f) => props(f).symbolType === "leg" && f.geometry?.type === "LineString")
    .map((f) => {
      const base = `${props(f).from}→${props(f).to}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const coords = f.geometry!.coordinates as [number, number][];
      return { key: n > 1 ? `${base}#${n}` : base, coords, gaps: gapsOf(props(f).gaps), preclipped: props(f).preclipped === true };
    });
}

const lengthOf = (c: [number, number][]) => c.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - c[i][0], p[1] - c[i][1]), 0);

/** Stored vs regenerated editor geometry. */
export function compareEditorGeometry(stored: GeometryLike, regenerated: GeometryLike): EditorComparison {
  const structure: string[] = [];
  const op = pointsOf(stored), np = pointsOf(regenerated);
  if (op.map((p) => `${p.type}:${p.code}`).join() !== np.map((p) => `${p.type}:${p.code}`).join()) structure.push(`points ${op.map((p) => p.code).join(",")} → ${np.map((p) => p.code).join(",")}`);
  const circles: EditorComparison["circles"] = { compared: 0, same: 0, diffs: [] };
  const newCuts = new Map(np.filter((p) => p.type === "control").map((p) => [p.code, p]));
  const done = new Set<string>();
  for (const p of op) {
    if (p.type !== "control" || done.has(p.code)) continue;
    done.add(p.code);
    const q = newCuts.get(p.code);
    if (!q) continue;
    if (Math.hypot(p.xy[0] - q.xy[0], p.xy[1] - q.xy[1]) > 1e-9) {
      structure.push(`${p.code} moved`);
      continue;
    }
    circles.compared++;
    const status = statusOf(p.cuts, q.cuts);
    if (status === "same") circles.same++;
    else circles.diffs.push({ key: p.code, status, old: p.cuts, new: q.cuts, oldWidth: circleWidth(p.cuts), newWidth: circleWidth(q.cuts) });
  }
  const legs: EditorComparison["legs"] = { compared: 0, same: 0, diffs: [] };
  const newLegs = new Map(legsOf(regenerated).map((l) => [l.key, l]));
  for (const l of legsOf(stored)) {
    const m = newLegs.get(l.key);
    if (!m) {
      structure.push(`leg ${l.key} gone`);
      continue;
    }
    // A leg of a moved control is part of the stale row, not compared.
    const moved = m.coords.length !== l.coords.length || l.coords.some((c, i) => Math.hypot(c[0] - m.coords[i][0], c[1] - m.coords[i][1]) > 1e-9);
    if (moved) continue;
    legs.compared++;
    const status = statusOf(l.gaps, m.gaps);
    if (status === "same") legs.same++;
    else {
      const len = lengthOf(m.coords);
      legs.diffs.push({ key: l.key, status, old: l.gaps, new: m.gaps, oldWidth: legWidth(l.gaps, len), newWidth: legWidth(m.gaps, len) });
    }
  }
  return { structure, circles, legs };
}

export interface ImportedFidelity {
  /** Leg features grouped per `from→to` (pieces of one leg count once). */
  legs: number;
  /** Legs drawn as file pieces (`preclipped`). */
  preclippedLegs: number;
  /** Of those, legs with a piece off the centre-to-centre line by more than 0.1 mm: need `LegProps.path`. */
  bentLegs: number;
  /** Largest such offset, mm. */
  maxBendMm: number;
  /** Controls (by code) with file-authored circle cuts. */
  authoredCutControls: number;
  /** Authored vs automatic circle cuts per control: overlapping, authored only, automatic only. */
  cutAgreement: { both: number; authoredOnly: number; automaticOnly: number };
  /** Non-leg, non-point features by `symbolType` (structure v1 carries `marked_route`, `restricted_line`, `forbidden_route`, `restricted_area` as extras). */
  extras: Record<string, number>;
}

function arcsOverlap(a: Gap[], b: Gap[]): boolean {
  const spans = (gs: Gap[]) => gs.flatMap((g) => {
    const s = (g as { start: number }).start, e = (g as { end: number }).end;
    return s <= e ? [[s, e]] : [[s, 360], [0, e]];
  });
  return spans(a).some(([s1, e1]) => spans(b).some(([s2, e2]) => s1 < e2 && s2 < e1));
}

/** Offset of `p` from the infinite line a → b, mm. */
function offLine(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  return len === 0 ? Math.hypot(p[0] - a[0], p[1] - a[1]) : Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

/**
 * What structure v1 would lose from imported geometry. `features` are the
 * event's cut features (null = no map): the automatic cuts the layer would
 * draw at the legacy sizes, against the file's own.
 */
export function importedCourseFidelity(stored: GeometryLike, features: readonly course.CutFeature[] | null): ImportedFidelity {
  const points = pointsOf(stored);
  const at = new Map(points.map((p) => [p.code, p.xy]));
  const legs = legsOf(stored);
  const byLeg = new Map<string, typeof legs>();
  for (const l of legs) {
    const k = l.key.replace(/#\d+$/, "");
    byLeg.set(k, [...(byLeg.get(k) ?? []), l]);
  }
  let preclippedLegs = 0, bentLegs = 0, maxBendMm = 0;
  for (const [k, pieces] of byLeg) {
    if (!pieces.some((p) => p.preclipped)) continue;
    preclippedLegs++;
    const [from, to] = k.split("→");
    const a = at.get(from), b = at.get(to);
    if (!a || !b) continue;
    const bend = Math.max(...pieces.flatMap((p) => p.coords.map((c) => offLine(c, a, b))));
    maxBendMm = Math.max(maxBendMm, bend);
    if (bend > BEND_MM) bentLegs++;
  }
  const cutAgreement = { both: 0, authoredOnly: 0, automaticOnly: 0 };
  let authoredCutControls = 0;
  const seen = new Set<string>();
  for (const p of points) {
    if (p.type !== "control" || seen.has(p.code)) continue;
    seen.add(p.code);
    if (p.cuts.length > 0) authoredCutControls++;
    const auto = features ? course.circleCuts(features, p.xy[0], p.xy[1]) : [];
    if (p.cuts.length > 0 && auto.length > 0) cutAgreement[arcsOverlap(p.cuts, auto) ? "both" : "authoredOnly"]++;
    else if (p.cuts.length > 0) cutAgreement.authoredOnly++;
    else if (auto.length > 0) cutAgreement.automaticOnly++;
  }
  const extras: Record<string, number> = {};
  for (const f of stored.features) {
    const t = String(props(f).symbolType ?? "");
    if (f.geometry?.type === "Point" || t === "leg") continue;
    extras[t] = (extras[t] ?? 0) + 1;
  }
  return { legs: byLeg.size, preclippedLegs, bentLegs, maxBendMm, authoredCutControls, cutAgreement, extras };
}
