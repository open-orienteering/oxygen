/**
 * Sheet resolution for the vector print path (docs/course-print.md §5;
 * research 08 §4.6): today's `resolveMapLayout` output — the template's
 * paper, frame and objects, the window, the course's controls and legs,
 * the description rows and text values — turned into the page input the
 * composer (`@oxygen/shared/print`) draws. Templates and sheet rows are
 * read as they are (09 §4 C); `resolve-layout.ts` is not changed, so the
 * legacy SVG page and this one resolve the same layout.
 *
 * The map document's part of the page (`PageInput.map`, `geo`) is added
 * by the caller (`pdf-page.ts`), which loads the pinned document.
 */

import { course, getPaperDimensions } from "@oxygen/shared";
import type { PageInput } from "@oxygen/shared/print";
import { type ResolveMapLayoutInput, type ResolvedMapLayout, resolveMapLayout } from "./resolve-layout.js";

export type SheetInput = Omit<PageInput, "map" | "geo">;

export interface ResolveSheetInput extends ResolveMapLayoutInput {
  /**
   * `courses.structure` (course-layer.md §6): the leg gaps the file or
   * the editor authored come from it, whatever `geometry_source` is.
   * Absent or invalid = the automatic gaps.
   */
  structure?: unknown;
  /** The event's course objects in scope of this sheet (course-layer.md §8.3), in draw order. */
  courseObjects?: readonly course.CourseLayerObject[];
  /** Stable id carried into the structure (the course's uuid or seq); default `course`. */
  courseId?: string;
}

export interface ResolvedSheet {
  layout: ResolvedMapLayout;
  sheet: SheetInput;
}

/**
 * The authored leg gaps of the stored structure, by index into the layout's
 * controls. The layout's start and finish come from the geometry (ids
 * `S1` / `F1`), the middle controls are the structure's own sites, so the
 * two sequences are aligned on the first site they share.
 */
function legGapsByIndex(layout: ResolvedMapLayout, stored: course.StoredCourseStructure | null): Map<number, course.FractionGap[]> {
  const out = new Map<number, course.FractionGap[]>();
  if (!stored) return out;
  const items = course.structureControlItems(stored);
  const ids = layout.controls.map((c) => c.id);
  const anchor = items.findIndex((item) => ids.includes(item.siteId));
  if (anchor < 0) return out;
  const offset = ids.indexOf(items[anchor].siteId) - anchor;
  items.forEach((item, j) => {
    const i = j + offset;
    if (j > 0 && i > 0 && i < ids.length && item.leg?.gaps?.length) out.set(i, item.leg.gaps);
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
  const gaps = legGapsByIndex(layout, parsed?.success ? parsed.data : null);
  const items: course.CourseItem[] = layout.controls.map((c, i) => {
    const item: course.CourseItem = { siteId: c.id, role: c.type };
    const legGaps = gaps.get(i);
    if (legGaps) item.leg = { gaps: legGaps };
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
  const { structure, sites } = courseInputOfLayout(layout, {
    kind: input.kind,
    orderMode: input.course?.orderMode,
    structure: input.structure,
    circleGaps: circleGapsOf([...(input.course?.controls ?? []), ...(input.allControls ?? [])]),
    courseId: input.courseId,
  });
  const title = input.course?.name ?? input.mapName ?? "";
  const sheet: SheetInput = {
    paper: { widthMm: paper.width, heightMm: paper.height },
    frame: document.mapFrame,
    window: layout.window,
    course: {
      structure,
      sites,
      appearance: course.appearanceFromTemplate(document.appearance),
      viewOptions: { allControls: input.kind === "all_controls", labelMode: layout.labelMode, overprintScale: layout.overprintScale },
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
