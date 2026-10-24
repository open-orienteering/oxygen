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

import { course, getPaperDimensions, type CourseOverlayLeg } from "@oxygen/shared";
import type { PageInput } from "@oxygen/shared/print";
import { type ResolveMapLayoutInput, type ResolvedMapLayout, resolveMapLayout } from "./resolve-layout.js";

export type SheetInput = Omit<PageInput, "map" | "geo">;

export interface ResolveSheetInput extends ResolveMapLayoutInput {
  /**
   * `courses.geometry_source`. `ocd`: the stored geometry's leg bends,
   * leg gaps, pre-clipped pieces and circle gaps are file-authored and
   * kept (docs/course-layer.md §2); anything else: the course layer
   * derives legs and automatic cuts itself.
   */
  geometrySource?: string | null;
  /** Stable id carried into the structure (the course's uuid or seq); default `course`. */
  courseId?: string;
}

export interface ResolvedSheet {
  layout: ResolvedMapLayout;
  sheet: SheetInput;
}

const EXTRA_KINDS = new Set<CourseOverlayLeg["kind"]>(["marked_route", "forbidden_route", "restricted_line"]);

/** The course layer's structure, sites and label offsets from a resolved layout (docs/course-print.md §5.2). */
export function courseInputOfLayout(
  layout: ResolvedMapLayout,
  opts: { kind: string; orderMode?: "ordered" | "free_order"; authored: boolean; courseId?: string },
): Pick<PageInput["course"], "structure" | "sites"> {
  const sites: course.CourseSite[] = [];
  const seen = new Set<string>();
  for (const c of layout.controls) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    sites.push({ id: c.id, code: c.code, kind: c.type, x: c.x, y: c.y });
  }
  if (opts.kind !== "course") return { structure: null, sites };

  const legs = layout.legs.filter((l) => (l.kind ?? "leg") === "leg");
  // Authored legs map onto items when the geometry has one leg into each item after the first.
  const legsFit = opts.authored && legs.length === layout.controls.length - 1;
  const items: course.CourseItem[] = layout.controls.map((c, i) => {
    const item: course.CourseItem = { siteId: c.id, role: c.type };
    if (opts.authored && c.cuts?.length) item.circleGaps = c.cuts;
    const leg = legsFit && i > 0 ? legs[i - 1] : undefined;
    if (leg) {
      item.leg = leg.preclipped
        ? { pieces: [leg.points] }
        : { path: leg.points, ...(leg.gaps?.length ? { gaps: leg.gaps } : {}) };
    }
    return item;
  });
  const labelOffsets: Record<string, { dx: number; dy: number }> = {};
  for (const c of layout.controls) {
    if (c.labelPosition) labelOffsets[c.id] = { dx: c.labelPosition.x - c.x, dy: c.labelPosition.y - c.y };
  }
  const extras: course.CourseExtra[] = layout.legs
    .filter((l) => l.kind && EXTRA_KINDS.has(l.kind))
    .map((l) => ({ kind: l.kind as course.CourseExtra["kind"], points: l.points }));
  return {
    sites,
    structure: {
      version: 1,
      id: opts.courseId ?? "course",
      orderMode: opts.orderMode ?? "ordered",
      items,
      ...(Object.keys(labelOffsets).length ? { labelOffsets } : {}),
      ...(extras.length ? { extras } : {}),
    },
  };
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
    authored: input.geometrySource === "ocd",
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
