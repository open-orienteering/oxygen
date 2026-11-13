/**
 * The course layer's input from what `MapViewer` already has
 * (docs/course-layer.md §5): controls with their positions (drag and
 * pending moves applied), the highlighted courses, their label offsets,
 * the stored structure's authored leg gaps and hidden numbers and the
 * controls' authored circle cuts, and the editor's provisional visit.
 * Pure; the worker adds the
 * document context and the cut features (docs/map-rendering.md §5.2
 * "Dynamic bucket").
 */

import { course } from "@oxygen/shared";
import type { CourseLayerRequest, PageLayerRequest } from "../map-gl/worker";

type Pt = { x: number; y: number };

export interface RequestControl {
  id: string;
  code: string;
  /** How the site draws (course-layer.md §10.3): crossing and map-issue points are never items; an exchange is a `Control`. */
  type: "Start" | "Control" | "Finish" | "Crossing" | "MapIssue";
  /** A `Control` that is a map exchange (`controls.kind`, course-layer.md §11): the layer splits the course into parts at it. */
  exchange?: boolean;
  visible?: boolean;
  /** `controls.circle_gaps`: authored cuts, compass degrees; non-empty replaces the automatic ones (course-layer.md §6.4). */
  circleGaps?: course.AngularGap[];
}

export interface RequestCourse {
  name: string;
  /** Ordered control ids, start and finish included. */
  controls: string[];
  highlight?: boolean;
  orderMode?: "ordered" | "free_order";
  labelOffsets?: Record<string, { dx: number; dy: number }>;
  /** The stored structure's legs whole (style, bends, gaps, corridor, crossing), keyed `"<fromId>><toId>"` (course-layer.md §5, §10). */
  legs?: Record<string, course.CourseLegProps>;
  /** Ids of the controls whose number every visit hides. */
  hiddenNumbers?: readonly number[];
  /** The editor's All-variations view (docs/course-editor.md §12): an alternative drawn in its tint (course-layer.md §12.7). */
  tint?: string;
  /** All variations (F15): explicit label text per control id when the variants number alike → `viewOptions.labels`. */
  labels?: Record<string, string>;
}

/** The provisional visit's site id: not a control, never hit-tested (docs/course-editor.md §6.1). */
export const PROVISIONAL_SITE_ID = "provisional";

/**
 * Where an armed `S` / `K` / `M` would place (docs/course-editor.md §6.1):
 * spliced into the single highlighted course, so the layer draws the
 * pending legs, their cuts and the numbers as the click would write them.
 */
export interface ProvisionalVisit {
  role: course.CourseSite["kind"];
  /** Control-sequence position a control goes to (its Control-typed entries, repeats counted); start and finish ignore it. */
  insertAt: number;
  /** The cursor, paper mm. */
  pt: Pt;
  /** An existing site reused at the visit: spliced by its id, no site added. */
  reuseId?: string;
  /** The new site's code (the next code of the allocation). */
  code?: string;
}

export interface CourseRequestInput {
  controls: readonly RequestControl[];
  /** Paper mm per control id; a control without one is not positioned and is not drawn. */
  positions: ReadonlyMap<string, Pt>;
  courses: readonly RequestCourse[];
  highlightCourseName?: string;
  /** Sequence numbers for a single ordered course (the description sheet or the editor is shown). */
  sequenceLabels: boolean;
  /**
   * The single course's number offset for a control (stored, pending or being dragged). Default: the
   * stored offsets. Either way offsets apply only with `sequenceLabels` (the sheet or the editor).
   */
  labelOffset?: (id: string) => { dx: number; dy: number } | undefined;
  /** Controls the GL layer leaves out (the editor's faded controls; the UI layer draws them). */
  exclude?: ReadonlySet<string>;
  /** Course objects in scope of the view (`courseObjectsForView`), in draw order (course-layer.md §8.3). */
  courseObjects?: readonly course.CourseObject[];
  /** The armed tool's visit; drawn with exactly one highlighted course only. */
  provisional?: ProvisionalVisit | null;
  /** Layout mode's sheet (docs/course-layout.md §1); absent in every other view. */
  layout?: LayoutRequest | null;
  /**
   * The event's automatic cuts (`course.getOverprintCuts`, course-layer.md §3.4). `false`: the
   * layer draws no automatic slits or leg gaps, stored ones still apply. Absent = on.
   */
  autoCuts?: boolean;
  /**
   * Setter marks (course-layer.md §10.3): the editor's Course and All-controls views draw the
   * map-issue points (702) and every crossing point; every other view only the crossings its legs run through.
   */
  setterMarks?: boolean;
}

/**
 * The sheet Layout mode draws, as the composer takes it: the page (its
 * layout objects — all page-anchored since F12 — and the block become the
 * page part), and what the map layer of the sheet adds to the course
 * layer — the template's appearance, the frame window (a toner saver's
 * ring) and the text values.
 */
export interface LayoutRequest {
  page: PageLayerRequest;
  appearance: course.CourseAppearance;
  /** The sheet's part of a course split by map exchanges (`course_maps.section_index`, course-layer.md §11). */
  section?: number;
}

/**
 * Whether the layer adds a site — and so draws a circle — for the visit: a
 * reuse splices an existing site and adds none. The armed tool's UI-layer
 * ghost circle is drawn exactly when this is false (docs/course-editor.md
 * §6.1, P4), so the two never show concentric.
 */
export const provisionalDrawn = (v: ProvisionalVisit | null | undefined): boolean => !!v && !v.reuseId;

/**
 * The course's control ids with the provisional visit spliced in: a control
 * before the `insertAt`-th control visit (else before the trailing finish,
 * else last); a start replaces the course's start (else leads); a finish
 * replaces its finish (else ends) — the structure the click writes.
 */
export function spliceProvisional(ids: readonly string[], typeOf: (id: string) => RequestControl["type"] | undefined, v: ProvisionalVisit): string[] {
  const id = v.reuseId ?? PROVISIONAL_SITE_ID;
  const out = [...ids];
  const lastFinish = () => out.map((x) => typeOf(x)).lastIndexOf("Finish");
  if (v.role === "start") {
    const i = out.findIndex((x) => typeOf(x) === "Start");
    if (i >= 0) out[i] = id;
    else out.unshift(id);
  } else if (v.role === "finish") {
    const i = lastFinish();
    if (i >= 0) out[i] = id;
    else out.push(id);
  } else {
    let seen = 0;
    let i = out.findIndex((x) => typeOf(x) === "Control" && seen++ === v.insertAt);
    if (i < 0) i = lastFinish();
    if (i < 0) i = out.length;
    out.splice(i, 0, id);
  }
  return out;
}

/**
 * The course objects drawn with the highlighted courses (course-layer.md
 * §8.2): `all`-scoped ones always, others when a drawn course is among the
 * courses the server resolved their scope to (`inCourses`: named courses
 * and the courses of named classes, forking pools included — print's
 * rule). No highlighted course (all controls): `all` only.
 */
export function courseObjectsForView(
  objects: readonly course.CourseObject[],
  highlighted: ReadonlySet<string>,
  courses: readonly { id: number; name: string }[],
): course.CourseObject[] {
  const drawn = new Set(courses.filter((c) => highlighted.has(c.name)).map((c) => c.id));
  return objects.filter((o) => o.inCourses === null || o.inCourses.some((id) => drawn.has(id)));
}

const KIND: Record<RequestControl["type"], course.CourseSite["kind"]> = {
  Start: "start", Control: "control", Finish: "finish", Crossing: "crossing_point", MapIssue: "map_issue",
};
/** Sites that are never items (§10.3): the layer decides when they draw, so they never make a view "all controls". */
const isMark = (s: course.CourseSite) => s.kind === "crossing_point" || s.kind === "map_issue";

/** A `course.controlCoordinates` row's drawn type: by its kind (course-layer.md §10.3), else the wire status 4 / 5; an exchange is a control. */
export function overlayTypeOf(c: { status: number; kind?: string }): RequestControl["type"] {
  if (c.kind === "crossing_point") return "Crossing";
  if (c.kind === "map_issue") return "MapIssue";
  if (c.kind === "start" || (c.kind === undefined || c.kind === "control") && c.status === 4) return "Start";
  if (c.kind === "finish" || (c.kind === undefined || c.kind === "control") && c.status === 5) return "Finish";
  return "Control";
}

/**
 * The on-map sheet's derived crossing rows (`buildDescriptionSheet`'s
 * `crossings`; course-layer.md §10.3): one per leg of the course's id list
 * whose stored leg runs through a crossing point, anchored after the
 * control it leaves (its code as the sheet's row id), `null` after the start.
 */
export function sheetCrossings(
  c: { controls: readonly string[]; legs?: Record<string, course.CourseLegProps>; orderMode?: "ordered" | "free_order" },
  overlays: readonly { id: string; code: string; type: RequestControl["type"] }[] | undefined,
): { afterControlId: number | null; section: boolean }[] {
  if (!c.legs || c.orderMode === "free_order") return [];
  const out: { afterControlId: number | null; section: boolean }[] = [];
  for (let i = 1; i < c.controls.length; i++) {
    const crossing = c.legs[`${c.controls[i - 1]}>${c.controls[i]}`]?.crossing;
    if (!crossing) continue;
    const from = overlays?.find((o) => o.id === c.controls[i - 1]);
    if (from?.type === "Start") out.push({ afterControlId: null, section: !!crossing.section });
    else {
      const id = Number.parseInt(String(from?.code ?? c.controls[i - 1]), 10);
      if (Number.isFinite(id)) out.push({ afterControlId: id, section: !!crossing.section });
    }
  }
  return out;
}

/**
 * The on-map sheet's derived map-exchange rows (`buildDescriptionSheet`'s
 * `exchanges`; course-layer.md §11): one per exchange visit of the course's
 * id list, after the exchange control (its code as the sheet's row id).
 */
export function sheetExchanges(
  c: { controls: readonly string[] },
  overlays: readonly { id: string; code: string; exchange?: boolean }[] | undefined,
): { afterControlId: number }[] {
  const out: { afterControlId: number }[] = [];
  for (const cid of c.controls) {
    const o = overlays?.find((x) => x.id === cid);
    if (!o?.exchange) continue;
    const id = Number.parseInt(String(o.code), 10);
    if (Number.isFinite(id)) out.push({ afterControlId: id });
  }
  return out;
}

export function courseLayerRequest(input: CourseRequestInput): CourseLayerRequest {
  const sites: course.CourseSite[] = [];
  const codeOf = new Map<string, string>();
  for (const c of input.controls) {
    codeOf.set(c.id, c.code);
    if (c.visible === false || input.exclude?.has(c.id)) continue;
    const p = input.positions.get(c.id);
    if (!p || (p.x === 0 && p.y === 0)) continue;
    const kind = c.exchange && c.type === "Control" ? "map_exchange" : KIND[c.type];
    sites.push({ id: c.id, code: c.code, kind, x: p.x, y: p.y, ...(c.circleGaps?.length ? { circleGaps: c.circleGaps } : {}) });
  }
  const highlighted = input.courses.filter((c) => c.highlight || c.name === input.highlightCourseName);
  const pv = highlighted.length === 1 ? input.provisional ?? null : null;
  if (pv && provisionalDrawn(pv)) sites.push({ id: PROVISIONAL_SITE_ID, code: pv.code ?? "", kind: pv.role, x: pv.pt.x, y: pv.pt.y });
  const drawn = new Set(sites.map((s) => s.id));
  const typeOf = new Map(input.controls.map((c) => [c.id, c.type] as const));

  const structures: course.CourseStructure[] = highlighted.map((c) => {
    const hidden = new Set((c.hiddenNumbers ?? []).map(String));
    const ids = pv ? spliceProvisional(c.controls, (id) => typeOf.get(id), pv) : c.controls;
    const items: course.CourseItem[] = ids.map((siteId, i) => {
      const item: course.CourseItem = { siteId };
      // Keyed by the drawn neighbours: the leg a provisional visit splits is not the stored one.
      const leg = i > 0 ? c.legs?.[`${ids[i - 1]}>${siteId}`] : undefined;
      if (leg && Object.keys(leg).length) item.leg = leg;
      if (hidden.has(siteId)) item.numberHidden = true;
      return item;
    });
    return {
      version: 1,
      id: c.name,
      orderMode: c.orderMode ?? "ordered",
      // Items whose site is not drawn stay: the layer skips them and joins the neighbours (§2).
      items,
      ...(c.tint ? { tint: c.tint } : {}),
    };
  });

  const single = highlighted.length === 1 ? highlighted[0] : undefined;
  if (single && structures[0] && input.sequenceLabels) {
    const offsets: Record<string, { dx: number; dy: number }> = {};
    for (const id of single.controls) {
      const off = input.labelOffset ? input.labelOffset(id) : single.labelOffsets?.[id];
      if (off) offsets[id] = off;
    }
    if (Object.keys(offsets).length) structures[0].labelOffsets = offsets;
  }

  const onCourse = new Set(structures.flatMap((s) => s.items.map((i) => i.siteId)).filter((id) => drawn.has(id)));
  const allControls = sites.some((s) => !onCourse.has(s.id) && !isMark(s));
  // F15: the All-variations spine's numbers (no other draw carries labels).
  const labelled = highlighted.filter((c) => c.labels);
  const labels = labelled.length > 0 ? Object.assign({}, ...labelled.map((c) => c.labels)) as Record<string, string> : undefined;
  const sequence = input.sequenceLabels && !!single && (single.orderMode ?? "ordered") === "ordered";
  return {
    structure: structures.length === 0 ? null : structures,
    sites,
    // The layer reads the body and the id; scope, z, token and resolved courses stay with the list.
    objects: (input.courseObjects ?? []).map(({ scope: _s, z: _z, version: _v, inCourses: _c, ...o }) => o as course.CourseLayerObject),
    appearance: input.layout?.appearance ?? {},
    viewOptions: {
      labelMode: sequence ? "sequence" : "code",
      ...(allControls ? { allControls: true } : {}),
      ...(input.setterMarks ? { setterMarks: true } : {}),
      // §12.7: a tinted course is the editor's All-variations view, never print.
      ...(highlighted.some((c) => c.tint) ? { allVariations: true } : {}),
      ...(labels ? { labels } : {}),
      ...(input.autoCuts === false ? { autoCuts: false } : {}),
      ...(input.layout
        ? {
            window: course.mapLayerWindow(input.layout.page),
            ...(input.layout.page.textValues ? { textValues: input.layout.page.textValues } : {}),
            ...(input.layout.section !== undefined ? { section: input.layout.section } : {}),
          }
        : {}),
    },
    ...(input.layout ? { page: input.layout.page } : {}),
  };
}
