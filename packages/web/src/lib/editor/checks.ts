/**
 * The editor's checks (docs/course-editor.md §8; docs/course-layer.md §9):
 * `courseChecks`'s input from the page's data, the server's
 * `DESCRIPTION_STALE` added to the client's list, the canvas markers, the
 * length KPI from the layer's legs and the click-to-locate target. Layer
 * site ids are the public control ids as strings.
 */

import { course, mapDocument, type ControlDescription, type ControlKind } from "@oxygen/shared";
import type { ToolShape } from "../../components/MapViewer";

type Structure = course.WireCourseStructure;

/** A check as the editor lists it: layer (string) site ids; `server` for the ones `course.checks` adds. */
export type EditorCheck = course.CourseCheck & { server?: true };

/** A `course.checks` row: public ids as numbers. */
export interface ServerCheck {
  code: course.CourseCheckCode;
  siteIds: number[];
  leg?: { from: number; to: number; index: number };
  at: { x: number; y: number };
  params?: Record<string, string | number>;
}

/** Codes only the server computes; the rest the editor has live. */
const SERVER_ONLY: ReadonlySet<course.CourseCheckCode> = new Set(["DESCRIPTION_STALE"]);

export function checkSitesOf(
  coords: readonly { id: number; code: string; mapX: number; mapY: number }[],
  controls: readonly { id: number; codes: string; kind: ControlKind; description: ControlDescription | null }[],
): course.CheckSite[] {
  const rowById = new Map(controls.map((c) => [c.id, c] as const));
  return coords.map((c) => {
    const row = rowById.get(c.id);
    return {
      id: String(c.id),
      code: c.code,
      codes: (row?.codes ?? "").split(";").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n)),
      kind: row?.kind ?? "control",
      x: c.mapX,
      y: c.mapY,
      description: row?.description ?? null,
    };
  });
}

/** The (explicit) wire structure in the layer's form; a variation group is skipped (slice F). */
export function checkStructureOf(courseId: number, s: Structure): course.CourseStructure {
  return {
    version: 1,
    id: String(courseId),
    orderMode: s.orderMode,
    items: s.items.flatMap((i) => (i.kind === "variation" ? [] : [{
      siteId: String(i.siteId),
      ...(i.role ? { role: i.role as course.CourseSite["kind"] } : {}),
      ...(i.numberHidden ? { numberHidden: true } : {}),
    }])),
  };
}

const documents = new Map<string, course.CheckDocument>();

/** The document's library and obstacles, built once per document hash. */
export function checkDocumentFor(hash: string, bytes: ArrayBuffer | Uint8Array): course.CheckDocument {
  let doc = documents.get(hash);
  if (!doc) {
    doc = course.checkObstaclesOfDocument(mapDocument.decodeMapDocument(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
    documents.clear();
    documents.set(hash, doc);
  }
  return doc;
}

/** The client's list plus the server's `DESCRIPTION_STALE` rows, in the code table's order. */
export function mergeChecks(client: readonly course.CourseCheck[], server: readonly ServerCheck[] | undefined): EditorCheck[] {
  const extra: EditorCheck[] = (server ?? []).filter((c) => SERVER_ONLY.has(c.code)).map((c) => ({
    code: c.code,
    siteIds: c.siteIds.map(String),
    ...(c.leg ? { leg: { from: String(c.leg.from), to: String(c.leg.to), index: c.leg.index } } : {}),
    at: c.at,
    ...(c.params ? { params: c.params } : {}),
    server: true,
  }));
  const rank = new Map<string, number>(course.COURSE_CHECK_CODES.map((c, i) => [c, i]));
  return [...client, ...extra]
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank.get(a.c.code)! - rank.get(b.c.code)! || a.i - b.i)
    .map(({ c }) => c);
}

const positioned = (p: { x: number; y: number }) => p.x !== 0 || p.y !== 0;
export const CHECK_MARKER_COLOR = "#d97706";

/**
 * UI-layer markers: an amber ring around each site of a site check, an
 * amber cross at a leg check's point (paper mm; `ringMm` the circle radius).
 */
export function checkMarkers(checks: readonly EditorCheck[], sites: ReadonlyMap<string, { x: number; y: number }>, ringMm: number): ToolShape[] {
  const out: ToolShape[] = [];
  const r = ringMm * 1.5;
  for (const c of checks) {
    if (c.leg) {
      if (!positioned(c.at)) continue;
      const d = ringMm * 0.6;
      const data = { code: c.code, x: String(c.at.x), y: String(c.at.y) };
      out.push({ kind: "line", points: [{ x: c.at.x - d, y: c.at.y - d }, { x: c.at.x + d, y: c.at.y + d }], color: CHECK_MARKER_COLOR, widthPx: 2.5, testId: "editor-check-marker", data });
      out.push({ kind: "line", points: [{ x: c.at.x - d, y: c.at.y + d }, { x: c.at.x + d, y: c.at.y - d }], color: CHECK_MARKER_COLOR, widthPx: 2.5 });
      continue;
    }
    for (const id of c.siteIds) {
      const s = sites.get(id);
      if (!s || !positioned(s)) continue;
      out.push({ kind: "circle", x: s.x, y: s.y, rMm: r, dashed: true, color: CHECK_MARKER_COLOR, testId: "editor-check-marker", data: { code: c.code, site: id } });
    }
  }
  return out;
}

/** The course length from the layer's leg polylines, metres; null without a derivation or scale. */
export function legsLengthM(derivation: course.CourseDerivation | null | undefined, mapScale: number | null): number | null {
  const legs = derivation?.courses[0]?.legs;
  if (!legs || !mapScale) return null;
  let mm = 0;
  for (const leg of legs) for (let i = 1; i < leg.points.length; i++) mm += Math.hypot(leg.points[i].x - leg.points[i - 1].x, leg.points[i].y - leg.points[i - 1].y);
  return (mm * mapScale) / 1000;
}

/** Click-to-locate: the site to select (a leg check: its first site) and the point to centre on. */
export function locateTarget(c: EditorCheck, sites: ReadonlyMap<string, { x: number; y: number }>): { selectId: number | null; centre: { x: number; y: number } | null } {
  const first = c.leg ? c.leg.from : c.siteIds[0];
  const id = first !== undefined && /^\d+$/.test(first) ? Number(first) : null;
  const s = first !== undefined ? sites.get(first) : undefined;
  const centre = positioned(c.at) ? c.at : s && positioned(s) ? { x: s.x, y: s.y } : null;
  return { selectId: id, centre };
}
