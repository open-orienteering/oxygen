/**
 * One-shot backfill of `courses.structure` (docs/course-layer.md §6.4;
 * research 09 §5). Courses with a NULL column get the structure their
 * columns describe; `ocd` rows also get the authored cuts, leg gaps and
 * course objects their stored GeoJSON carries, so nothing of an imported
 * course lives only there. Per course in its own transaction, idempotent by
 * `structure IS NULL`, and it reports what the regenerated geometry looks
 * like next to the stored one (C5's comparison).
 *
 * It writes the `structure` column only (like `rewriteStructureFromColumns`:
 * the flat columns are what they were), advances no token and journals
 * nothing: it derives what the columns already replicate.
 */

import { course } from "@oxygen/shared";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { Prisma as PrismaNs } from "./generated/prisma/client.js";
import { legacySizeContext } from "./course-geometry.js";
import { compareEditorGeometry, type GeometryLike } from "./course-geometry-compare.js";
import { collectImportedObjects, legGapsOfFeatures } from "./course-import-structure.js";
import { writeImportedObjects } from "./course-import-objects.js";
import { loadExplicitStructure } from "./course-structure.js";
import { lockCourseVersion } from "./version-conflict.js";
import type { GeoJSONFeatureCollection } from "./iof-course-parser.js";

type Db = PrismaClient | Prisma.TransactionClient;

export interface StructureBackfillItem {
  courseId: string;
  eventId: bigint;
  event: string;
  name: string;
  source: string;
}

/** Regenerated vs stored geometry of one course (09 §5, C5's comparison). */
export interface GeometryComparison {
  /** Largest corner shift of the points' bounding box, paper mm. */
  bboxDeltaMm: number;
  /** Largest shift of a control's position, paper mm. */
  positionDeltaMm: number;
  controls: number;
  /** Circle cuts compared / equal (authored cuts carried into the regenerated geometry). */
  circles: { compared: number; same: number };
  /** Legs the file drew as pieces / of those, how many regenerate with the same gaps. */
  legs: { pieces: number; withGaps: number };
}

export interface StructureBackfillResult {
  courseId: string;
  event: string;
  name: string;
  source: string;
  outcome: "filled" | "skipped" | "failed";
  error?: string;
  items?: number;
  /** Controls whose `circle_gaps` were filled from the file's cuts. */
  circleGapControls?: number;
  legGaps?: number;
  objects?: number;
  /** Why authored cuts / gaps were not moved (the stored sequence is not the structure's). */
  note?: string;
  comparison?: GeometryComparison;
}

/** Courses still without a structure, in event then course order. */
export async function planStructureBackfill(db: Db, opts: { eventId?: bigint } = {}): Promise<StructureBackfillItem[]> {
  const rows = await db.course.findMany({
    where: { structure: { equals: PrismaNs.DbNull }, removed: false, ...(opts.eventId !== undefined ? { eventId: opts.eventId } : {}), event: { removed: false } },
    select: { id: true, eventId: true, name: true, geometrySource: true, event: { select: { nameId: true } } },
    orderBy: [{ eventId: "asc" }, { seq: "asc" }],
  });
  return rows.map((r) => ({ courseId: r.id, eventId: r.eventId, event: r.event.nameId, name: r.name, source: r.geometrySource }));
}

type Feature = GeoJSONFeatureCollection["features"][number];
const propsOf = (f: Feature) => (f.properties ?? {}) as Record<string, unknown>;

/** The stored geometry's points in course order: start, controls, finish (repeats kept). */
function pointsOf(geometry: GeoJSONFeatureCollection): { code: string; type: string; xy: [number, number]; cuts: course.AngularGap[] }[] {
  return geometry.features.flatMap((f) => {
    if (f.geometry.type !== "Point") return [];
    const p = propsOf(f);
    const cuts = Array.isArray(p.cuts) ? (p.cuts as course.AngularGap[]).map((g) => ({ start: g.start, end: g.end })) : [];
    return [{ code: String(p.code ?? p.id ?? ""), type: String(p.symbolType ?? ""), xy: f.geometry.coordinates as [number, number], cuts }];
  });
}

const bboxOf = (pts: readonly [number, number][]) =>
  pts.length === 0 ? null : { x0: Math.min(...pts.map((p) => p[0])), x1: Math.max(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), y1: Math.max(...pts.map((p) => p[1])) };

/**
 * Compare the stored geometry with what the layer regenerates from the
 * structure, the sites' circle gaps and the structure's leg gaps. No cut
 * features: automatic cuts are the editor's business, the comparison is of
 * what the file authored.
 */
export function compareRegenerated(
  stored: GeoJSONFeatureCollection,
  structure: course.StoredCourseStructure,
  sites: ReadonlyMap<string, { code: string; kind: course.CourseSite["kind"]; x: number; y: number; circleGaps?: course.AngularGap[] }>,
): GeometryComparison {
  const layer = course.courseLayer({
    structure: structure as unknown as course.CourseStructure,
    sites: [...sites].map(([id, s]) => ({ id, ...s })),
    objects: [],
    appearance: {},
    viewOptions: {},
    document: legacySizeContext(),
  });
  const regenerated = course.courseLayerGeoJson(layer, structure.id);
  const sp = pointsOf(stored), rp = pointsOf(regenerated as unknown as GeoJSONFeatureCollection);
  const sb = bboxOf(sp.map((p) => p.xy)), rb = bboxOf(rp.map((p) => p.xy));
  const bboxDeltaMm = sb && rb ? Math.max(Math.abs(sb.x0 - rb.x0), Math.abs(sb.x1 - rb.x1), Math.abs(sb.y0 - rb.y0), Math.abs(sb.y1 - rb.y1)) : 0;
  const at = new Map(rp.map((p) => [`${p.type}:${p.code}`, p.xy]));
  let positionDeltaMm = 0;
  for (const p of sp) {
    const q = at.get(`${p.type}:${p.code}`);
    if (q) positionDeltaMm = Math.max(positionDeltaMm, Math.hypot(p.xy[0] - q[0], p.xy[1] - q[1]));
  }
  const cmp = compareEditorGeometry(stored as unknown as GeometryLike, regenerated as unknown as GeometryLike);
  const storedLegGaps = legGapsOfFeatures(stored, (code) => {
    const xy = sp.find((p) => p.code === code)?.xy;
    return xy ? { x: xy[0], y: xy[1] } : undefined;
  });
  const pieceLegs = new Set(stored.features.filter((f) => propsOf(f).symbolType === "leg" && propsOf(f).preclipped === true).map((f) => `${propsOf(f).from}>${propsOf(f).to}`));
  const regeneratedGapped = new Set((regenerated.features as Feature[]).filter((f) => propsOf(f).symbolType === "leg" && Array.isArray(propsOf(f).gaps)).map((f) => `${propsOf(f).from}>${propsOf(f).to}`));
  return {
    bboxDeltaMm,
    positionDeltaMm,
    controls: new Set(sp.filter((p) => p.type === "control").map((p) => p.code)).size,
    circles: { compared: cmp.circles.compared, same: cmp.circles.same },
    legs: { pieces: pieceLegs.size, withGaps: [...storedGapKeys(storedLegGaps)].filter((k) => regeneratedGapped.has(k)).length },
  };
}
const storedGapKeys = (m: Map<string, unknown>) => m.keys();

/** Fill one course, in its own transaction; a no-op when the column is no longer NULL. */
export async function backfillCourseStructure(db: PrismaClient, item: StructureBackfillItem): Promise<StructureBackfillResult> {
  const head = { courseId: item.courseId, event: item.event, name: item.name, source: item.source };
  try {
    return await db.$transaction(async (tx) => {
      await lockCourseVersion(tx, item.courseId);
      const row = await tx.course.findUniqueOrThrow({ where: { id: item.courseId }, select: { structure: true, geometry: true, geometrySource: true, name: true } });
      if (row.structure !== null) return { ...head, outcome: "skipped" as const };
      const { structure } = await loadExplicitStructure(tx, item.eventId, item.courseId);
      const items = course.structureControlItems(structure);
      const siteRows = await tx.control.findMany({
        where: { id: { in: [...new Set(items.map((i) => i.siteId))] } },
        select: { id: true, codes: true, kind: true, status: true, xpos: true, ypos: true, circleGaps: true },
      });
      const siteById = new Map(siteRows.map((r) => [r.id, r]));
      const geometry = row.geometry as unknown as GeoJSONFeatureCollection | null;
      const authored = row.geometrySource === "ocd" && !!geometry?.features;
      let note: string | undefined;
      let legGaps = 0, circleGapControls = 0, objects = 0;
      let written: course.StoredCourseStructure = structure;
      // The geometry's own codes for the sites (STA1, 71, FIN1 …), when its sequence is the course's.
      const geometryCodes = new Map<string, string>();

      if (authored) {
        const pts = pointsOf(geometry!);
        if (pts.length === items.length) {
          const codeOf = new Map(items.map((i, j) => [i.siteId, pts[j].code]));
          for (const [siteId, code] of codeOf) geometryCodes.set(siteId, code);
          const gaps = legGapsOfFeatures(geometry!, (code) => {
            const xy = pts.find((p) => p.code === code)?.xy;
            return xy ? { x: xy[0], y: xy[1] } : undefined;
          });
          written = {
            ...structure,
            items: items.map((item, j) => {
              const found = j > 0 ? gaps.get(`${pts[j - 1].code}>${pts[j].code}`) : undefined;
              if (!found) return item;
              legGaps++;
              return { ...item, leg: { ...item.leg, gaps: found } };
            }),
          };
          const done = new Set<string>();
          for (const [siteId, code] of codeOf) {
            const cuts = pts.find((p) => p.code === code)?.cuts ?? [];
            const site = siteById.get(siteId);
            const had = Array.isArray(site?.circleGaps) && (site!.circleGaps as unknown as unknown[]).length > 0;
            if (!site || cuts.length === 0 || had || done.has(siteId)) continue;
            done.add(siteId);
            await tx.control.update({ where: { id: siteId }, data: { circleGaps: cuts as never } });
            site.circleGaps = cuts as never;
            circleGapControls++;
          }
        } else {
          note = `geometry has ${pts.length} points, the course ${items.length} sites: cuts and gaps not moved`;
        }
        objects = await writeImportedObjects(tx, item.eventId, collectImportedObjects(new Map([[row.name, geometry!]])), () => item.courseId, { replace: false });
      }

      await tx.course.update({ where: { id: item.courseId }, data: { structure: written as unknown as Prisma.InputJsonValue } });

      let comparison: GeometryComparison | undefined;
      if (geometry?.features) {
        const sites = new Map<string, { code: string; kind: course.CourseSite["kind"]; x: number; y: number; circleGaps?: course.AngularGap[] }>();
        for (const [id, r] of siteById) {
          const kind = r.kind !== "control" ? r.kind : r.status === "start" || r.status === "finish" ? r.status : "control";
          const gaps = Array.isArray(r.circleGaps) ? (r.circleGaps as unknown as course.AngularGap[]) : [];
          sites.set(id, { code: geometryCodes.get(id) ?? ((r.codes ?? "").split(";")[0] || id), kind: kind as course.CourseSite["kind"], x: r.xpos, y: r.ypos, ...(gaps.length ? { circleGaps: gaps } : {}) });
        }
        comparison = compareRegenerated(geometry, written, sites);
      }
      return { ...head, outcome: "filled" as const, items: items.length, circleGapControls, legGaps, objects, ...(note ? { note } : {}), ...(comparison ? { comparison } : {}) };
    });
  } catch (e) {
    return { ...head, outcome: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

export interface StructureBackfillRun {
  total: number;
  filled: number;
  skipped: number;
  failed: number;
  results: StructureBackfillResult[];
}

/** Run the backfill over the planned courses; `dryRun` plans only. */
export async function runStructureBackfill(
  db: PrismaClient,
  opts: { eventId?: bigint; dryRun?: boolean; onCourse?: (r: StructureBackfillResult, n: number, total: number) => void } = {},
): Promise<StructureBackfillRun> {
  const plan = await planStructureBackfill(db, { eventId: opts.eventId });
  const run: StructureBackfillRun = { total: plan.length, filled: 0, skipped: 0, failed: 0, results: [] };
  if (opts.dryRun) return run;
  for (const item of plan) {
    const r = await backfillCourseStructure(db, item);
    run.results.push(r);
    run[r.outcome === "filled" ? "filled" : r.outcome === "skipped" ? "skipped" : "failed"]++;
    opts.onCourse?.(r, run.results.length, plan.length);
  }
  return run;
}
