/**
 * Sheet resolution for the vector print path (docs/course-print.md §5;
 * research 08 §4.6): today's `resolveMapLayout` output — the template's
 * paper, frame and objects, the window, the course's controls and legs,
 * the description rows and text values — turned into the page input the
 * composer (`@oxygen/shared/print`) draws. Templates and sheet rows are
 * read as they are (09 §4 C).
 *
 * The map document's part of the page (`PageInput.map`, `geo`) is added
 * by the caller (`pdf-page.ts`), which loads the pinned document.
 */

import { course, getPaperDimensions } from "@oxygen/shared";
import type { PageInput } from "@oxygen/shared/print";
import { type LayoutControlSource, type ResolveMapLayoutInput, type ResolvedMapLayout, resolveMapLayout } from "./resolve-layout.js";

export type SheetInput = Omit<PageInput, "map" | "geo">;

export interface ResolveSheetInput extends ResolveMapLayoutInput {
  /**
   * `courses.structure` (course-layer.md §6): the leg gaps the file or
   * the editor authored come from it. Absent or invalid = the automatic
   * gaps.
   */
  structure?: unknown;
  /** The event's course objects in scope of this sheet (course-layer.md §8.3), in draw order. */
  courseObjects?: readonly course.CourseLayerObject[];
  /** Stable id carried into the structure (the course's uuid or seq); default `course`. */
  courseId?: string;
  /**
   * `Event.autoOverprintCuts` (course-layer.md §3.4): `false` puts
   * `autoCuts: false` on the sheet's view options, so the composer draws no
   * automatic slits or gaps; stored gaps still apply. Absent = on.
   */
  autoCuts?: boolean;
  /**
   * The all-variations page (course-print.md §4.6, F8; answer 4): a root's
   * `structure` drawn as the spine and every alternative's branch, in the
   * one purple (no tint) and with codes. `course.controls` are then every
   * visited control (`allVariationsRow`) and the course `free_order`, so
   * the block lists each once without numbers.
   */
  allVariations?: boolean;
}

export interface ResolvedSheet {
  layout: ResolvedMapLayout;
  sheet: SheetInput;
}

/**
 * The stored legs of the structure (`LegProps`: gaps, style, bends, …;
 * course-layer.md §10.1), by index into the layout's controls. The
 * layout's controls are the course's start and finish rows and its
 * `course_controls`; a start the layout does not draw (unplaced, or
 * `firstAsStart`) shifts the two sequences, so they are aligned on the
 * first site they share.
 */
function legPropsByIndex(layout: ResolvedMapLayout, stored: course.StoredCourseStructure | null): Map<number, course.LegProps> {
  const out = new Map<number, course.LegProps>();
  if (!stored) return out;
  const items = course.structureControlItems(stored);
  const ids = layout.controls.map((c) => c.id);
  const anchor = items.findIndex((item) => ids.includes(item.siteId));
  if (anchor < 0) return out;
  const offset = ids.indexOf(items[anchor].siteId) - anchor;
  items.forEach((item, j) => {
    const i = j + offset;
    if (j > 0 && i > 0 && i < ids.length && item.leg && Object.keys(item.leg).length > 0) out.set(i, item.leg);
  });
  return out;
}

/** The course layer's structure, sites and label offsets from a resolved layout (docs/course-print.md §5.2). */
export function courseInputOfLayout(
  layout: ResolvedMapLayout,
  opts: {
    kind: string;
    orderMode?: "ordered" | "free_order";
    structure?: unknown;
    /** `controls.circle_gaps` by control id. */
    circleGaps?: ReadonlyMap<string, course.AngularGap[]>;
    courseId?: string;
    /** The event's crossing points by control id (§10.3): a course sheet draws those its legs run through. */
    crossingSites?: ReadonlyMap<string, LayoutControlSource>;
  },
): Pick<PageInput["course"], "structure" | "sites"> {
  const sites: course.CourseSite[] = [];
  const seen = new Set<string>();
  for (const c of layout.controls) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const gaps = opts.circleGaps?.get(c.id);
    sites.push({ id: c.id, code: c.code, kind: c.type, x: c.x, y: c.y, ...(gaps?.length ? { circleGaps: gaps } : {}) });
  }
  if (opts.kind !== "course") return { structure: null, sites };

  const parsed = opts.structure ? course.courseStructureSchema.safeParse(opts.structure) : null;
  // The crossing points the legs run through (§10.3) are the sheet's sites too; others are not drawn.
  if (parsed?.success) {
    for (const item of course.structureControlItems(parsed.data)) {
      const id = item.leg?.crossing?.controlId;
      const c = id && !seen.has(id) ? opts.crossingSites?.get(id) : undefined;
      if (!c || (c.xpos === 0 && c.ypos === 0)) continue;
      seen.add(c.id);
      sites.push({ id: c.id, code: c.name || String(c.seq ?? ""), kind: "crossing_point", x: c.xpos, y: c.ypos });
    }
  }
  const legs = legPropsByIndex(layout, parsed?.success ? parsed.data : null);
  const items: course.CourseItem[] = layout.controls.map((c, i) => {
    // A course sheet's controls are its items: start, controls, finish.
    const item: course.CourseItem = { siteId: c.id, role: c.type === "start" || c.type === "finish" ? c.type : "control" };
    // The whole stored leg: gaps, style, bends (F1), corridor (F2), crossing (F4).
    const leg = legs.get(i);
    if (leg) item.leg = leg;
    return item;
  });
  const labelOffsets: Record<string, { dx: number; dy: number }> = {};
  for (const c of layout.controls) {
    if (c.labelPosition) labelOffsets[c.id] = { dx: c.labelPosition.x - c.x, dy: c.labelPosition.y - c.y };
  }
  return {
    sites,
    structure: {
      version: 1,
      id: opts.courseId ?? "course",
      orderMode: opts.orderMode ?? "ordered",
      items,
      ...(Object.keys(labelOffsets).length ? { labelOffsets } : {}),
    },
  };
}

/**
 * The all-variations page's structures (course-print.md §4.6): the root's
 * spine and one branch per alternative (`course.allVariationStructures`,
 * the editor's All-variations view without its tints), the layout's start
 * and finish completing the spine when the stored structure leaves them
 * implicit. Every structure carries the sheet's label offsets; the
 * crossing points any branch runs through are added to `sites`.
 */
function allVariationsInput(
  layout: ResolvedMapLayout,
  stored: course.StoredCourseStructure,
  sites: course.CourseSite[],
  courseId: string,
  crossingSites: ReadonlyMap<string, LayoutControlSource>,
): course.CourseStructure[] {
  const { spine, branches } = course.allVariationStructures(stored);
  const first = layout.controls[0];
  const last = layout.controls[layout.controls.length - 1];
  if (first?.type === "start" && spine[0]?.siteId !== first.id) spine.unshift({ siteId: first.id });
  if (last?.type === "finish" && spine[spine.length - 1]?.siteId !== last.id) spine.push({ siteId: last.id });
  const seen = new Set(sites.map((s) => s.id));
  const items = (list: readonly course.StoredControlItem[]): course.CourseItem[] =>
    list.map((c) => {
      const crossing = c.leg?.crossing?.controlId;
      const site = crossing && !seen.has(crossing) ? crossingSites.get(crossing) : undefined;
      if (site && (site.xpos !== 0 || site.ypos !== 0)) {
        seen.add(site.id);
        sites.push({ id: site.id, code: site.name || String(site.seq ?? ""), kind: "crossing_point", x: site.xpos, y: site.ypos });
      }
      const item: course.CourseItem = { siteId: c.siteId };
      if (c.leg && Object.keys(c.leg).length > 0) item.leg = c.leg;
      if (c.numberHidden) item.numberHidden = true;
      return item;
    });
  const labelOffsets: Record<string, { dx: number; dy: number }> = {};
  for (const c of layout.controls) {
    if (c.labelPosition) labelOffsets[c.id] = { dx: c.labelPosition.x - c.x, dy: c.labelPosition.y - c.y };
  }
  const shape = (id: string, list: readonly course.StoredControlItem[]): course.CourseStructure => ({
    version: 1,
    id,
    orderMode: stored.orderMode,
    items: items(list),
    ...(Object.keys(labelOffsets).length ? { labelOffsets } : {}),
  });
  return [shape(courseId, spine), ...branches.map((b) => shape(`${courseId}:${b.groupId}:${b.label}`, b.items))];
}

function circleGapsOf(controls: readonly { id: string; circleGaps?: unknown }[]): Map<string, course.AngularGap[]> {
  const out = new Map<string, course.AngularGap[]>();
  for (const c of controls) if (Array.isArray(c.circleGaps) && c.circleGaps.length > 0) out.set(c.id, c.circleGaps as course.AngularGap[]);
  return out;
}

/**
 * `resolveMapLayout` → the page input without the map document
 * (docs/course-print.md §5). Base-map scale and meridian tilt arrive in
 * `input.mapScale` / `input.meridianTiltDeg` from `getBaseMapInfo`.
 */
export function resolveSheet(input: ResolveSheetInput): ResolvedSheet {
  const layout = resolveMapLayout(input);
  const { document } = layout;
  const paper = getPaperDimensions(
    document.paper,
    document.orientation,
    document.paper === "custom" ? { width: document.paperWidthMm!, height: document.paperHeightMm! } : undefined,
  );
  const crossingSites = new Map((input.allControls ?? []).filter((c) => c.kind === "crossing_point").map((c) => [c.id, c]));
  const own = courseInputOfLayout(layout, {
    kind: input.kind,
    orderMode: input.course?.orderMode,
    structure: input.structure,
    circleGaps: circleGapsOf([...(input.course?.controls ?? []), ...(input.allControls ?? [])]),
    courseId: input.courseId,
    crossingSites,
  });
  // A mutable copy: the all-variations page adds the crossing points its branches run through.
  const sites = [...own.sites];
  let structure: PageInput["course"]["structure"] = own.structure;
  if (input.allVariations && input.kind === "course") {
    const parsed = input.structure ? course.courseStructureSchema.safeParse(input.structure) : null;
    if (parsed?.success && course.hasVariations(parsed.data)) {
      structure = allVariationsInput(layout, parsed.data, sites, input.courseId ?? "course", crossingSites);
    }
  }
  const title = input.course?.name ?? input.mapName ?? "";
  const sheet: SheetInput = {
    paper: { widthMm: paper.width, heightMm: paper.height },
    frame: document.mapFrame,
    window: layout.window,
    course: {
      structure,
      sites,
      appearance: course.appearanceFromTemplate(document.appearance),
      viewOptions: {
        allControls: input.kind === "all_controls" || input.kind === "setter",
        // §10.3: the all-controls and setter sheets (F10) are setter views (702, their crossing points); a course sheet never is.
        ...(input.kind === "all_controls" || input.kind === "setter" ? { setterMarks: true } : {}),
        labelMode: layout.labelMode,
        ...(input.autoCuts === false ? { autoCuts: false } : {}),
        // §11: a part sheet draws its part; numbers and the block stay the whole course's.
        ...(layout.section !== undefined ? { section: layout.section } : {}),
      },
      ...(input.courseObjects?.length ? { objects: input.courseObjects } : {}),
    },
    objects: document.objects,
    textValues: layout.textValues,
    description: document.description.visible
      ? {
          x: document.description.x,
          y: document.description.y,
          cellSizeMm: document.description.cellSizeMm,
          rows: layout.descriptionRows,
          header: layout.descriptionHeader,
          title,
        }
      : null,
    label: title,
  };
  return { layout, sheet };
}
