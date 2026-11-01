/**
 * The course layer's input from what `MapViewer` already has
 * (docs/course-layer.md §5): controls with their positions (drag and
 * pending moves applied), the highlighted courses, their label offsets,
 * the stored structure's authored leg gaps and hidden numbers and the
 * controls' authored circle cuts. Pure; the worker adds the
 * document context and the cut features (docs/map-rendering.md §5.2
 * "Dynamic bucket").
 */

import { course } from "@oxygen/shared";
import type { CourseLayerRequest } from "../map-gl/worker";

type Pt = { x: number; y: number };

export interface RequestControl {
  id: string;
  code: string;
  type: "Start" | "Control" | "Finish";
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
  /** Authored leg gaps of the stored structure, keyed `"<fromId>><toId>"` (course-layer.md §6.4). */
  legGaps?: Record<string, course.FractionGap[]>;
  /** Ids of the controls whose number every visit hides. */
  hiddenNumbers?: readonly number[];
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

const KIND: Record<RequestControl["type"], course.CourseSite["kind"]> = { Start: "start", Control: "control", Finish: "finish" };

export function courseLayerRequest(input: CourseRequestInput): CourseLayerRequest {
  const sites: course.CourseSite[] = [];
  const codeOf = new Map<string, string>();
  for (const c of input.controls) {
    codeOf.set(c.id, c.code);
    if (c.visible === false || input.exclude?.has(c.id)) continue;
    const p = input.positions.get(c.id);
    if (!p || (p.x === 0 && p.y === 0)) continue;
    sites.push({ id: c.id, code: c.code, kind: KIND[c.type], x: p.x, y: p.y, ...(c.circleGaps?.length ? { circleGaps: c.circleGaps } : {}) });
  }
  const drawn = new Set(sites.map((s) => s.id));

  const highlighted = input.courses.filter((c) => c.highlight || c.name === input.highlightCourseName);
  const structures: course.CourseStructure[] = highlighted.map((c) => {
    const hidden = new Set((c.hiddenNumbers ?? []).map(String));
    const items: course.CourseItem[] = c.controls.map((siteId, i) => {
      const item: course.CourseItem = { siteId };
      const gaps = i > 0 ? c.legGaps?.[`${c.controls[i - 1]}>${siteId}`] : undefined;
      if (gaps?.length) item.leg = { gaps };
      if (hidden.has(siteId)) item.numberHidden = true;
      return item;
    });
    return {
      version: 1,
      id: c.name,
      orderMode: c.orderMode ?? "ordered",
      // Items whose site is not drawn stay: the layer skips them and joins the neighbours (§2).
      items,
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
  const allControls = sites.some((s) => !onCourse.has(s.id));
  const sequence = input.sequenceLabels && !!single && (single.orderMode ?? "ordered") === "ordered";
  return {
    structure: structures.length === 0 ? null : structures,
    sites,
    // The layer reads the body and the id; scope, z, token and resolved courses stay with the list.
    objects: (input.courseObjects ?? []).map(({ scope: _s, z: _z, version: _v, inCourses: _c, ...o }) => o as course.CourseLayerObject),
    appearance: {},
    viewOptions: { labelMode: sequence ? "sequence" : "code", ...(allControls ? { allControls: true } : {}) },
  };
}
