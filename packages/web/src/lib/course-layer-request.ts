/**
 * The course layer's input from what `MapViewer` already has
 * (docs/course-layer.md §5): controls with their positions (drag and
 * pending moves applied), the highlighted courses, their label offsets,
 * the imported courses' file-authored geometry. Pure; the worker adds the
 * document context and the cut features (docs/map-rendering.md §5.2
 * "Dynamic bucket").
 */

import type { course } from "@oxygen/shared";
import type { CourseLayerRequest } from "../map-gl/worker";

type Pt = { x: number; y: number };

export interface RequestControl {
  id: string;
  code: string;
  type: "Start" | "Control" | "Finish";
  visible?: boolean;
}

export interface RequestCourse {
  name: string;
  /** Ordered control ids, start and finish included. */
  controls: string[];
  highlight?: boolean;
  orderMode?: "ordered" | "free_order";
  labelOffsets?: Record<string, { dx: number; dy: number }>;
}

interface GeoFeature {
  type?: string;
  geometry?: { type: string; coordinates: unknown } | null;
  properties?: Record<string, unknown> | null;
}

export interface CourseRequestInput {
  controls: readonly RequestControl[];
  /** Paper mm per control id; a control without one is not positioned and is not drawn. */
  positions: ReadonlyMap<string, Pt>;
  courses: readonly RequestCourse[];
  highlightCourseName?: string;
  /** `course.courseGeometries` merged, each feature tagged with `courseName` (MapPanel). */
  courseGeometry?: { features?: GeoFeature[] } | null;
  /** Sequence numbers for a single ordered course (the description sheet or the editor is shown). */
  sequenceLabels: boolean;
  /** The single course's number offset for a control (stored, pending or being dragged). */
  labelOffset?: (id: string) => { dx: number; dy: number } | undefined;
  /** Controls the GL layer leaves out (the editor's faded controls; the UI layer draws them). */
  exclude?: ReadonlySet<string>;
}

const KIND: Record<RequestControl["type"], course.CourseSite["kind"]> = { Start: "start", Control: "control", Finish: "finish" };

const lineCoords = (f: GeoFeature): Pt[] | null => {
  if (f.geometry?.type !== "LineString" || !Array.isArray(f.geometry.coordinates)) return null;
  return (f.geometry.coordinates as [number, number][]).map(([x, y]) => ({ x, y }));
};

const EXTRA_KINDS = new Set(["marked_route", "restricted_line", "forbidden_route"]);

/**
 * Imported `ocd` geometry kept by the layer (course-layer.md §2): a course
 * whose GeoJSON legs are `preclipped` was drawn by the file, so its legs
 * become authored pieces and its controls' `cuts` authored circle gaps;
 * bent legs keep their path. Automatic `gaps` / `cuts` of the legacy
 * GeoJSON are not read — the worker cuts from the document's features.
 */
function authoredGeometry(name: string, items: course.CourseItem[], codeOf: (siteId: string) => string, features: readonly GeoFeature[]): course.CourseExtra[] {
  const own = features.filter((f) => f.properties?.courseName === name);
  const legs = own.filter((f) => f.properties?.symbolType === "leg").map((f) => ({ pts: lineCoords(f), preclipped: f.properties?.preclipped === true }));
  const authored = legs.some((l) => l.preclipped);
  // Leg i runs into item i + 1; a count that does not match is not this sequence's geometry.
  if (legs.length === items.length - 1) {
    legs.forEach((l, i) => {
      if (!l.pts || l.pts.length < 2) return;
      if (l.preclipped) items[i + 1].leg = { pieces: [l.pts] };
      else if (l.pts.length > 2) items[i + 1].leg = { path: l.pts };
    });
  }
  if (authored) {
    const cutsByCode = new Map<string, course.AngularGap[]>();
    for (const f of own) {
      const p = f.properties;
      if (p?.symbolType === "control" && typeof p.code === "string" && Array.isArray(p.cuts) && p.cuts.length) cutsByCode.set(p.code, p.cuts as course.AngularGap[]);
    }
    for (const item of items) {
      const cuts = cutsByCode.get(codeOf(item.siteId));
      if (cuts) item.circleGaps = cuts.map((g) => ({ start: g.start, end: g.end }));
    }
  }
  const extras: course.CourseExtra[] = [];
  for (const f of own) {
    const kind = f.properties?.symbolType;
    if (typeof kind !== "string") continue;
    if (EXTRA_KINDS.has(kind)) {
      const pts = lineCoords(f);
      if (pts && pts.length >= 2) extras.push({ kind: kind as course.CourseExtra["kind"], points: pts });
    } else if (kind === "restricted_area" && f.geometry?.type === "Polygon" && Array.isArray(f.geometry.coordinates)) {
      // 709 as the OCD importer and `courseLayerGeoJson` name it.
      const ring = (f.geometry.coordinates as [number, number][][])[0];
      if (ring && ring.length >= 3) extras.push({ kind: "oob_area", points: ring.map(([x, y]) => ({ x, y })) });
    }
  }
  return extras;
}

export function courseLayerRequest(input: CourseRequestInput): CourseLayerRequest {
  const sites: course.CourseSite[] = [];
  const codeOf = new Map<string, string>();
  for (const c of input.controls) {
    codeOf.set(c.id, c.code);
    if (c.visible === false || input.exclude?.has(c.id)) continue;
    const p = input.positions.get(c.id);
    if (!p || (p.x === 0 && p.y === 0)) continue;
    sites.push({ id: c.id, code: c.code, kind: KIND[c.type], x: p.x, y: p.y });
  }
  const drawn = new Set(sites.map((s) => s.id));

  const highlighted = input.courses.filter((c) => c.highlight || c.name === input.highlightCourseName);
  const features = input.courseGeometry?.features ?? [];
  const structures: course.CourseStructure[] = highlighted.map((c) => {
    const items: course.CourseItem[] = c.controls.map((siteId) => ({ siteId }));
    const extras = authoredGeometry(c.name, items, (id) => codeOf.get(id) ?? "", features);
    return {
      version: 1,
      id: c.name,
      orderMode: c.orderMode ?? "ordered",
      // Items whose site is not drawn stay: the layer skips them and joins the neighbours (§2).
      items,
      ...(extras.length ? { extras } : {}),
    };
  });

  const single = highlighted.length === 1 ? highlighted[0] : undefined;
  if (single && structures[0]) {
    const offsets: Record<string, { dx: number; dy: number }> = {};
    for (const id of single.controls) {
      const off = input.labelOffset ? input.labelOffset(id) : single.labelOffsets?.[id];
      if (off) offsets[id] = off;
    }
    if (Object.keys(offsets).length) structures[0].labelOffsets = offsets;
  }

  const onCourse = new Set(structures.flatMap((s) => s.items.map((i) => i.siteId)).filter((id) => drawn.has(id)));
  const allControls = sites.some((s) => !onCourse.has(s.id));
  const sequence = input.sequenceLabels && !!single && (single.orderMode ?? "ordered") === "ordered";
  return {
    structure: structures.length === 0 ? null : structures,
    sites,
    objects: [],
    appearance: {},
    viewOptions: { labelMode: sequence ? "sequence" : "code", ...(allControls ? { allControls: true } : {}) },
  };
}
