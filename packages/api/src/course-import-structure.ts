/**
 * What an imported course's file-authored geometry becomes besides the
 * sequence (docs/course-layer.md §6.4): leg gaps from the 705 pieces, and
 * the course-level lines and areas as course-object bodies. Pure; the
 * importer reads the parser's import-time GeoJSON shape (what
 * `courses.geometry` of an `ocd` row held until E5 dropped the column).
 * Since F9 also the legs' bends (a Purple Pen `<leg>`, drawn into the leg
 * feature so the import alignment moves them) and the leg an item gets
 * from all of the file's leg properties (`importedLegProps`).
 */

import type { course } from "@oxygen/shared";
import type { GeoJSONFeatureCollection } from "./iof-course-parser.js";

interface P { x: number; y: number }
type FractionGap = { from: number; to: number };

/** Gaps narrower than this are the touching ends of two pieces, not a gap (paper mm). */
const MIN_GAP_MM = 0.2;

/**
 * The gaps of the leg `a`→`b` the pieces leave: the uncovered stretches
 * between the first and the last covered one (the stretch inside a
 * circle is clearance, not a gap). Pieces are projected onto the centre
 * line; fractions are rounded to four decimals.
 */
export function legGapsFromPieces(a: P, b: P, pieces: readonly (readonly (readonly [number, number])[])[]): FractionGap[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0 || pieces.length < 2) return [];
  const t = ([x, y]: readonly [number, number]) => ((x - a.x) * dx + (y - a.y) * dy) / (len * len);
  const spans = pieces
    .map((p) => {
      const ts = p.map(t);
      return [Math.min(...ts), Math.max(...ts)] as const;
    })
    .sort((m, n) => m[0] - n[0]);
  const gaps: FractionGap[] = [];
  let reach = spans[0][1];
  for (const [from, to] of spans.slice(1)) {
    if ((from - reach) * len >= MIN_GAP_MM) gaps.push({ from: Math.round(reach * 1e4) / 1e4, to: Math.round(from * 1e4) / 1e4 });
    reach = Math.max(reach, to);
  }
  return gaps;
}

type Feature = GeoJSONFeatureCollection["features"][number];
const symbolOf = (f: Feature) => (f.properties as { symbolType?: string } | null)?.symbolType;

/** The leg gaps of a course geometry, keyed `"<fromCode>><toCode>"` (legs without a gap are absent). */
export function legGapsOfFeatures(geometry: GeoJSONFeatureCollection, positionOf: (code: string) => P | undefined): Map<string, FractionGap[]> {
  const pieces = new Map<string, [number, number][][]>();
  for (const f of geometry.features) {
    const p = f.properties as { symbolType?: string; from?: string; to?: string; preclipped?: boolean } | null;
    if (p?.symbolType !== "leg" || !p.preclipped || !p.from || !p.to || f.geometry.type !== "LineString") continue;
    const key = `${p.from}>${p.to}`;
    const list = pieces.get(key) ?? [];
    list.push(f.geometry.coordinates as [number, number][]);
    pieces.set(key, list);
  }
  const out = new Map<string, FractionGap[]>();
  for (const [key, list] of pieces) {
    const [from, to] = key.split(">");
    const a = positionOf(from), b = positionOf(to);
    if (!a || !b) continue;
    const gaps = legGapsFromPieces(a, b, list);
    if (gaps.length > 0) out.set(key, gaps);
  }
  return out;
}

/**
 * The bends of a course geometry's bent legs, keyed `"<fromCode>><toCode>"`:
 * the inner vertices of a leg feature the parser marked `bent` (Purple
 * Pen's `<leg>`, `buildStraightLineGeometry`). An OCD bundle's pre-clipped
 * pieces are not read (their bends stay Pending, course-layer.md §6.4).
 * The first leg of a pair wins. Imported bends are corners: no file read
 * here carries a handle (F13, course-layer.md §10.1).
 */
export function legBendsOfFeatures(geometry: GeoJSONFeatureCollection): Map<string, P[]> {
  const out = new Map<string, P[]>();
  for (const f of geometry.features) {
    const p = f.properties as { symbolType?: string; from?: string; to?: string; bent?: boolean; preclipped?: boolean } | null;
    if (p?.symbolType !== "leg" || !p.bent || p.preclipped || !p.from || !p.to || f.geometry.type !== "LineString") continue;
    const key = `${p.from}>${p.to}`;
    const inner = (f.geometry.coordinates as [number, number][]).slice(1, -1);
    if (inner.length > 0 && !out.has(key)) out.set(key, inner.map(([x, y]) => ({ x, y })));
  }
  return out;
}

/**
 * The leg an imported item carries (course-layer.md §6.4 "Importers"): the
 * file's gaps (OCD), bends (Purple Pen), marked route and crossing point
 * (IOF `TapedRoute` / `CrossingPoint`, the crossing by its site's UUID).
 * Undefined when the file says nothing about the leg.
 */
export function importedLegProps(input: {
  gaps?: FractionGap[];
  bends?: P[];
  style?: "marked_route";
  crossing?: { controlId: string; section?: boolean };
}): course.LegProps | undefined {
  const leg: course.LegProps = {};
  if (input.gaps?.length) leg.gaps = input.gaps;
  if (input.bends?.length) leg.bends = input.bends;
  if (input.style) leg.style = input.style;
  if (input.crossing) leg.crossing = { controlId: input.crossing.controlId, ...(input.crossing.section ? { section: true } : {}) };
  return Object.keys(leg).length > 0 ? leg : undefined;
}

export interface ImportedObject {
  body: course.CourseObjectBody;
  /** Names of the imported courses whose geometry carried it: its scope. */
  courseNames: string[];
}

const vertices = (coords: readonly (readonly number[])[]): { x: number; y: number }[] => coords.map(([x, y]) => ({ x, y }));

function bodyOf(f: Feature): course.CourseObjectBody | null {
  const sym = symbolOf(f);
  if (f.geometry.type === "LineString") {
    const geometry = vertices(f.geometry.coordinates);
    if (geometry.length < 2) return null;
    if (sym === "marked_route") return { kind: "marked_route", geometry, props: {} };
    if (sym === "restricted_line") return { kind: "oob_line", geometry, props: {} };
    if (sym === "forbidden_route") return { kind: "oob_line", geometry, props: { symbol: "711" } };
  } else if (f.geometry.type === "Polygon" && sym === "restricted_area") {
    const ring = f.geometry.coordinates[0] ?? [];
    const open = ring.length > 1 && ring[0][0] === ring.at(-1)![0] && ring[0][1] === ring.at(-1)![1] ? ring.slice(0, -1) : ring;
    if (open.length < 3) return null;
    return { kind: "oob_area", geometry: vertices(open), props: {} };
  }
  return null;
}

/**
 * The course objects of a file, each scoped to the courses whose geometry
 * carries it (707 by T-code map; 708 / 709 / 711 are in every course of
 * the file). Identical (kind, props, geometry) across courses is one
 * object. Leg cuts and description boxes are not objects.
 */
export function collectImportedObjects(geometries: ReadonlyMap<string, GeoJSONFeatureCollection>): ImportedObject[] {
  const byKey = new Map<string, ImportedObject>();
  for (const [courseName, geometry] of geometries) {
    for (const f of geometry.features) {
      const body = bodyOf(f);
      if (!body) continue;
      const key = JSON.stringify([body.kind, body.props, body.geometry]);
      const found = byKey.get(key);
      if (!found) byKey.set(key, { body, courseNames: [courseName] });
      else if (!found.courseNames.includes(courseName)) found.courseNames.push(courseName);
    }
  }
  return [...byKey.values()];
}
