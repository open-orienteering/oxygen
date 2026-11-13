/**
 * Shared course-map layout resolution.
 *
 * Turns a map template (plus optional course-map overrides and a course or
 * the event's full control set) into the resolved print document, the map
 * window it shows, the overlay geometry and the text placeholder values.
 *
 * `courseMap.list`, `resolveSheet` and the print path go through here so a
 * template preview and a saved map page resolve identically. Pure and
 * isomorphic (docs/course-print.md §1): the browser resolves the same
 * sheets as the API (G13).
 */

import { z } from "zod";
import { displayCode, firstCode, isStartOrFinish } from "../control-display.js";
import { courseSequenceOf, crossingRowsOf, rowKind, type SequenceColumns } from "../course/sequence.js";
import { sectionsOf } from "../course/structure.js";
import type { ControlDescription, CourseDescriptionInstructions } from "../types.js";
import { type DescriptionRow, type DescriptionSheetHeader, buildDescriptionSheet } from "./description-rows.js";
import { mapWindowForFrame } from "./geometry.js";
import type { CourseOverlayControl, CourseOverlayLeg } from "./overlay-types.js";
import {
  type CourseMapDocument,
  type CourseMapObject,
  type CourseMapOverrides,
  type MapPoint,
  type MapWindow,
  courseMapObjectSchema,
  mapTemplateSettingsSchema,
} from "./schema.js";
import type { MapTextValues } from "./text.js";

const objectsSchema = z.array(courseMapObjectSchema);

/** Control row as stored in `oxygen.controls` — only the fields we need. */
export interface LayoutControlSource {
  id: string;
  seq?: number | null;
  codes: string;
  /** Database role; only start/finish affect all-controls overlays. */
  status?: string;
  /** `controls.name` / `controls.kind`: what `layoutCourseEnds` matches a course's start and finish by. */
  name?: string;
  kind?: string;
  xpos: number;
  ypos: number;
  /** IOF description JSONB from `oxygen.controls.description`. */
  description?: unknown;
  /** Manual number offset from the control centre, map millimetres. */
  labelOffset?: { dx: number; dy: number };
  /** `controls.circle_gaps` JSONB: authored circle cuts (course-layer.md §6.4). */
  circleGaps?: unknown;
  /** The block row's A-column number, set by the all-variations page (F15, course-print.md §4.6); absent = the ordinal rule. */
  sequence?: number;
}

/** Map template row — `settings` / `objects` are raw JSONB. */
export interface LayoutTemplateSource {
  paper: string;
  orientation: string;
  paperWidthMm: number | null;
  paperHeightMm: number | null;
  printScale: number;
  settings: unknown;
  objects: unknown;
}

export interface LayoutCourseSource {
  name: string;
  lengthM: number;
  climbM: number;
  /** Visit-order mode — free-order drops legs and uses code labels. */
  orderMode?: "ordered" | "free_order";
  /**
   * The start and finish the course draws, resolved by the caller
   * (`layoutCourseEnds`); null / absent = none. Unplaced (0, 0) ones are
   * not drawn.
   */
  start?: LayoutControlSource | null;
  finish?: LayoutControlSource | null;
  classes?: Array<{ name: string }>;
  /** Course controls in course order. */
  controls: LayoutControlSource[];
  /** `courses.description_instructions` JSONB (specials + finish variant). */
  descriptionInstructions?: unknown;
  /**
   * The legs through crossing points (`crossingRowsOf`, course-layer.md
   * §10.3): the block derives its 13.3 / 13.4 rows from them.
   */
  crossings?: ReadonlyArray<{ afterControlId: number | null; section: boolean }>;
}

/** A course's `crossings` from its stored structure over the event's controls (public ids: first code, else seq). */
export function layoutCrossings(structure: unknown, allControls: readonly LayoutControlSource[]): { afterControlId: number | null; section: boolean }[] {
  const byId = new Map(allControls.map((c) => [c.id, c]));
  return crossingRowsOf(
    structure,
    (uuid) => {
      const c = byId.get(uuid);
      return c ? firstCode(c.codes) || (c.seq ?? undefined) : undefined;
    },
    (uuid) => {
      const c = byId.get(uuid);
      return !!c && rowKind({ kind: c.kind ?? "control", status: c.status ?? "" }) === "start";
    },
  );
}

/** An all-controls sheet's drawn type of a site (course-layer.md §10.3): by kind, else the legacy status; an exchange is a control. */
function allControlsType(c: LayoutControlSource): CourseOverlayControl["type"] {
  const kind = rowKind({ kind: c.kind ?? "control", status: c.status ?? "" });
  return kind === "start" || kind === "finish" || kind === "crossing_point" || kind === "map_issue" ? kind : "control";
}

/** Loose reader for the instructions JSONB — anything malformed → null. */
function readInstructions(raw: unknown): CourseDescriptionInstructions | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const out: CourseDescriptionInstructions = {};
  if (Array.isArray(obj.specials)) {
    out.specials = obj.specials
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .filter((s) => typeof s.kind === "string")
      .map((s) => ({
        afterControlId:
          typeof s.afterControlId === "number" ? s.afterControlId : null,
        kind: s.kind as string,
        ...(typeof s.lengthM === "number" ? { lengthM: s.lengthM } : {}),
      }));
  }
  if (obj.finish && typeof obj.finish === "object") {
    const f = obj.finish as Record<string, unknown>;
    if (typeof f.kind === "string") {
      out.finish = {
        kind: f.kind,
        ...(typeof f.lengthM === "number" ? { lengthM: f.lengthM } : {}),
      };
    }
  }
  return out;
}

/** Attach a course-control's stored number offset onto the control row. */
export function layoutControlsFromCourseControls(
  rows: Array<{
    control: LayoutControlSource;
    labelDx?: number | null;
    labelDy?: number | null;
  }>,
): LayoutControlSource[] {
  return rows.map(({ control, labelDx, labelDy }) => ({
    ...control,
    ...(labelDx != null && labelDy != null
      ? { labelOffset: { dx: labelDx, dy: labelDy } }
      : {}),
  }));
}

export interface ResolveMapLayoutInput {
  /** `"course"`, `"all_controls"` or `"setter"` (its group in `allControls`, F10); anything else resolves without overlay. */
  kind: string;
  template: LayoutTemplateSource;
  overrides?: CourseMapOverrides;
  /** Page-level objects stored on the course map itself. */
  objects?: CourseMapObject[];
  course?: LayoutCourseSource | null;
  /** Event control set, used by `all_controls` maps. */
  allControls?: LayoutControlSource[];
  /** Saved window center; falls back to the overlay bounding-box center. */
  windowCenter?: MapPoint | null;
  /** Base map scale; falls back to the print scale when no map is uploaded. */
  mapScale?: number | null;
  /**
   * In-paper tilt of the drawn meridian lines (degrees clockwise from
   * paper +Y, `getBaseMapInfo().meridianTiltDeg`). Applied as
   * `rotationDeg = -tilt` so the meridians stand vertical on the page.
   *
   * NOT `map_files.north_offset`: that value is the bearing from *true*
   * north to display-up, which MapViewer applies to tiles that were first
   * warped into true-north mercator. The print pipeline renders raw OCAD
   * paper space — no warp — so only the drawing's own tilt applies.
   */
  meridianTiltDeg?: number | null;
  event?: { name: string; date: Date };
  /** Value for the `{map}` placeholder. */
  mapName?: string;
  /**
   * The sheet's part of a course split by map exchanges
   * (`course_maps.section_index`, course-layer.md §11). A NULL window
   * centre then centres on that part's controls; out of range, or a
   * one-part course, is the whole course.
   */
  section?: number;
  /**
   * The `{variant}` placeholder (course-print.md §4.6, F8): a variant
   * page's key, the all-variations page's keys; absent = "".
   */
  variantKey?: string;
}

export interface ResolvedMapLayout {
  document: CourseMapDocument;
  window: MapWindow;
  controls: CourseOverlayControl[];
  legs: CourseOverlayLeg[];
  /**
   * How control numbers are labelled on the overprint. Free-order and
   * all-controls maps use punch codes; ordered course maps use 1,2,3…
   */
  labelMode: "sequence" | "code";
  /**
   * Description block rows. Course maps carry the full IOF sheet (start,
   * controls, specials, finish); all-controls maps list control rows only.
   */
  descriptionRows: DescriptionRow[];
  /**
   * Three-row IOF header (event / classes / course · length · climb) for
   * course maps; null for all-controls maps, which keep a single title row.
   */
  descriptionHeader: DescriptionSheetHeader | null;
  textValues: MapTextValues;
  /** The part drawn (`input.section`) when the course has ≥ 2 parts and it is in range; the layer's `viewOptions.section`. */
  section?: number;
}

/**
 * The start and finish a course draws (docs/course-print.md §5.2 "Sites"):
 * the one sequence rule (`course/sequence.ts` `courseSequenceOf`) over the
 * event's live controls — the stored structure's explicit ends, else the
 * columns', completed by the lowest-seq start / finish unless
 * `firstAsStart` / `lastAsFinish`. A NULL structure reads the columns, as
 * the editor does.
 */
export function layoutCourseEnds(
  course: SequenceColumns,
  courseControlIds: readonly string[],
  allControls: readonly LayoutControlSource[],
): { start: LayoutControlSource | null; finish: LayoutControlSource | null } {
  type Site = LayoutControlSource & { name: string; kind: string; status: string };
  const sites: Site[] = allControls.map((c) => ({ ...c, name: c.name ?? "", kind: c.kind ?? "control", status: c.status ?? "" }));
  const bySeq = (a: Site, b: Site) => (a.seq ?? 0) - (b.seq ?? 0);
  const byId = new Map(sites.map((c) => [c.id, c]));
  const { start, finish } = courseSequenceOf(course, courseControlIds, {
    site: (id) => byId.get(id),
    starts: sites.filter((c) => c.status === "start").sort(bySeq),
    finishes: sites.filter((c) => c.status === "finish").sort(bySeq),
  });
  return { start, finish };
}

/** A course end as an overlay control; null when absent or unplaced. */
function endControl(row: LayoutControlSource | null | undefined, type: "start" | "finish"): CourseOverlayControl | null {
  if (!row || (row.xpos === 0 && row.ypos === 0)) return null;
  return {
    id: row.id,
    code: displayCode({ ...row, seq: null, kind: type }) || (type === "start" ? "S" : "F"),
    type,
    x: row.xpos,
    y: row.ypos,
  };
}

export function centerOfControls(controls: MapPoint[]): MapPoint | null {
  if (controls.length === 0) return null;
  const xs = controls.map((control) => control.x);
  const ys = controls.map((control) => control.y);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

export function resolveMapLayout(
  input: ResolveMapLayoutInput,
): ResolvedMapLayout {
  const settings = mapTemplateSettingsSchema.parse(input.template.settings);
  const templateObjects = objectsSchema.parse(input.template.objects);
  const overrides = input.overrides ?? {};
  const frame = overrides.mapFrame ?? settings.mapFrame;
  const printScale = overrides.printScale ?? input.template.printScale;
  // The all-controls sheet and a setter sheet (F10: its group, filtered by the caller) list sites, not a course.
  const everySite = input.kind === "all_controls" || input.kind === "setter";

  const rawControls =
    everySite
      ? (input.allControls ?? []).filter(
          (control) => control.xpos !== 0 || control.ypos !== 0,
        )
      : input.course?.controls ?? [];
  const regularControls = rawControls.map((control) => {
    // A start / finish by its name (F32, course-layer.md §6.3).
    const code = isStartOrFinish(control) ? displayCode(control) : control.codes.split(";")[0] || String(control.seq ?? "");
    const type: CourseOverlayControl["type"] =
      everySite ? allControlsType(control) : "control";
    const x = control.xpos;
    const y = control.ypos;
    return {
      id: control.id,
      code,
      type,
      x,
      y,
      description: control.description,
      ...(control.labelOffset
        ? {
            labelPosition: {
              x: x + control.labelOffset.dx,
              y: y + control.labelOffset.dy,
            },
          }
        : {}),
    };
  });
  if (everySite) {
    regularControls.sort((a, b) =>
      a.code.localeCompare(b.code, undefined, { numeric: true }),
    );
  }
  const start = input.kind === "course" ? endControl(input.course?.start, "start") : null;
  const finish = input.kind === "course" ? endControl(input.course?.finish, "finish") : null;
  const controls: CourseOverlayControl[] =
    input.kind === "course"
      ? [
          ...(start ? [start] : []),
          ...regularControls.map(({ description: _description, ...rest }) => {
            void _description;
            return rest;
          }),
          ...(finish ? [finish] : []),
        ]
      : regularControls.map(({ description: _description, ...rest }) => {
          void _description;
          return rest;
        });

  const controlRows = regularControls.filter(
    (control) => control.type === "control",
  );
  let descriptionRows: DescriptionRow[];
  let descriptionHeader: DescriptionSheetHeader | null = null;
  if (input.kind === "course" && input.course) {
    // Same row model as the on-map sheet in the course editor, so print
    // and screen agree on header, start, specials and finish.
    const lastControl = controlRows[controlRows.length - 1];
    const finishLengthM =
      finish && lastControl && input.mapScale
        ? (Math.hypot(finish.x - lastControl.x, finish.y - lastControl.y) *
            input.mapScale) /
          1000
        : null;
    const sheet = buildDescriptionSheet({
      eventName: input.event?.name ?? "",
      classNames: input.course.classes?.map((c) => c.name) ?? [],
      courseName: input.course.name,
      lengthM: input.course.lengthM,
      climbM: input.course.climbM,
      orderMode: input.course.orderMode ?? "ordered",
      controls: controlRows.map((control, index) => {
        const source = rawControls[regularControls.indexOf(control)];
        return {
          // The public control id (first code, else seq) — the id space
          // `afterControlId` is stored in (types.ts, course.setStructure's prune).
          id: source ? firstCode(source.codes) || (source.seq ?? index + 1) : index + 1,
          code: control.code,
          description: (control.description ?? null) as ControlDescription | null,
          ...(source?.sequence !== undefined ? { sequence: source.sequence } : {}),
        };
      }),
      instructions: readInstructions(input.course.descriptionInstructions),
      finishLengthM,
      ...(input.course.crossings?.length ? { crossings: input.course.crossings } : {}),
      // §11: a 13.5 row after each map exchange of the course's controls, by the rows' public id.
      exchanges: controlRows.flatMap((control, index) => {
        const source = rawControls[regularControls.indexOf(control)];
        return source?.kind === "map_exchange" ? [{ afterControlId: firstCode(source.codes) || (source.seq ?? index + 1) }] : [];
      }),
    });
    descriptionHeader = sheet.header;
    descriptionRows = sheet.rows.map((row) => ({
      kind: row.kind,
      code: row.code,
      ...(row.sequence !== undefined ? { sequence: row.sequence } : {}),
      ...(row.description !== undefined ? { description: row.description } : {}),
      ...(row.symbolKey !== undefined ? { symbolKey: row.symbolKey } : {}),
      ...(row.lengthM !== undefined ? { lengthM: row.lengthM } : {}),
    }));
  } else {
    descriptionRows = controlRows.map((control) => ({
      code: control.code,
      description: control.description as DescriptionRow["description"],
    }));
  }

  // Straight legs centre to centre between the drawn controls (the course
  // layer derives what the page draws; these are the list's overlay).
  const freeOrder = input.course?.orderMode === "free_order";
  const legs: CourseOverlayLeg[] = [];
  if (input.kind === "course" && !freeOrder) {
    for (let index = 0; index < controls.length - 1; index += 1) {
      legs.push({
        points: [
          { x: controls[index].x, y: controls[index].y },
          { x: controls[index + 1].x, y: controls[index + 1].y },
        ],
        kind: "leg",
      });
    }
  }

  const labelMode: "sequence" | "code" =
    everySite || freeOrder ? "code" : "sequence";

  // One part of a course split by map exchanges (course-layer.md §11): its controls centre the window.
  let section: number | undefined;
  let centred = controls;
  if (input.kind === "course" && input.section !== undefined) {
    const exchange = new Set(rawControls.filter((c) => c.kind === "map_exchange").map((c) => c.id));
    const placed = controls.filter((c) => c.x !== 0 || c.y !== 0);
    const parts = sectionsOf(placed, (c) => c.type === "control" && exchange.has(c.id));
    const part = parts[input.section];
    if (parts.length >= 2 && part) {
      section = input.section;
      centred = placed.slice(part.from, part.to + 1);
    }
  }
  const center =
    input.windowCenter ??
    centerOfControls(centred) ?? {
      x: 0,
      y: 0,
    };
  const meridianTilt = input.meridianTiltDeg ?? 0;
  const rotationDeg = Math.abs(meridianTilt) < 0.05 ? 0 : -meridianTilt;
  const window = mapWindowForFrame(
    frame,
    center,
    input.mapScale ?? printScale,
    printScale,
    rotationDeg,
  );

  const document: CourseMapDocument = {
    paper: input.template.paper as CourseMapDocument["paper"],
    orientation: input.template.orientation as CourseMapDocument["orientation"],
    ...(input.template.paperWidthMm === null
      ? {}
      : { paperWidthMm: input.template.paperWidthMm }),
    ...(input.template.paperHeightMm === null
      ? {}
      : { paperHeightMm: input.template.paperHeightMm }),
    printScale,
    printMarginMm: settings.printMarginMm,
    mapFrame: frame,
    description: {
      ...settings.description,
      ...overrides.description,
    },
    appearance: settings.appearance,
    objects: [...templateObjects, ...(input.objects ?? [])],
  };

  const course = input.course ?? null;
  return {
    document,
    window,
    controls,
    legs,
    labelMode,
    descriptionRows,
    descriptionHeader,
    ...(section !== undefined ? { section } : {}),
    textValues: {
      event: input.event?.name ?? "",
      course: course?.name ?? "",
      map: input.mapName ?? "",
      variant: input.variantKey ?? "",
      classes: course?.classes?.map((entry) => entry.name).join(", ") ?? "",
      scale: `1:${printScale}`,
      length: course ? `${course.lengthM} m` : "",
      climb: course ? `${course.climbM} m` : "",
      date: input.event ? input.event.date.toISOString().slice(0, 10) : "",
      controls: String(
        controls.filter((control) => control.type === "control").length,
      ),
    },
  };
}
