/**
 * Shared course-map layout resolution.
 *
 * Turns a map template (plus optional course-map overrides and a course or
 * the event's full control set) into the resolved print document, the map
 * window it shows, the overlay geometry and the text placeholder values.
 *
 * `courseMap.list` and `mapTemplate.previewLayout` both go through here so a
 * template preview and a saved map page resolve identically.
 */

import {
  buildDescriptionSheet,
  mapTemplateSettingsSchema,
  mapWindowForFrame,
  courseMapObjectSchema,
  type ControlDescription,
  type CourseDescriptionInstructions,
  type CourseMapDocument,
  type CourseMapObject,
  type CourseMapOverrides,
  type CourseOverlayControl,
  type CourseOverlayLeg,
  type DescriptionRow,
  type DescriptionSheetHeader,
  type MapPoint,
  type MapTextValues,
  type MapWindow,
} from "@oxygen/shared";
import { z } from "zod";

const objectsSchema = z.array(courseMapObjectSchema);

/** Control row as stored in `oxygen.controls` — only the fields we need. */
export interface LayoutControlSource {
  id: string;
  seq?: number | null;
  codes: string;
  /** Database role; only start/finish affect all-controls overlays. */
  status?: string;
  xpos: number;
  ypos: number;
  /** IOF description JSONB from `oxygen.controls.description`. */
  description?: unknown;
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
  /** GeoJSON FeatureCollection from the course importer. */
  geometry?: unknown;
  classes?: Array<{ name: string }>;
  /** Course controls in course order. */
  controls: LayoutControlSource[];
  /** `courses.description_instructions` JSONB (specials + finish variant). */
  descriptionInstructions?: unknown;
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

export interface ResolveMapLayoutInput {
  /** `"course"` or `"all_controls"`; anything else resolves without overlay. */
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
}

export interface ResolvedMapLayout {
  document: CourseMapDocument;
  window: MapWindow;
  controls: CourseOverlayControl[];
  legs: CourseOverlayLeg[];
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
  /**
   * ISOM overprint enlargement `mapScale / printScale` (1 when the base
   * map scale is unknown). A 1:15000 map printed at 1:7500 doubles the
   * control circles, numbers and line widths along with the terrain.
   */
  overprintScale: number;
}

export function courseGeometryControls(
  geometry: unknown,
): CourseOverlayControl[] {
  if (!geometry || typeof geometry !== "object") return [];
  const features = (geometry as { features?: unknown }).features;
  if (!Array.isArray(features)) return [];
  const controls: CourseOverlayControl[] = [];
  for (const raw of features) {
    if (!raw || typeof raw !== "object") continue;
    const feature = raw as {
      geometry?: { type?: unknown; coordinates?: unknown };
      properties?: Record<string, unknown>;
    };
    const symbolType = feature.properties?.symbolType;
    if (
      feature.geometry?.type !== "Point" ||
      (symbolType !== "start" &&
        symbolType !== "control" &&
        symbolType !== "finish") ||
      !Array.isArray(feature.geometry.coordinates)
    ) {
      continue;
    }
    const x = Number(feature.geometry.coordinates[0]);
    const y = Number(feature.geometry.coordinates[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    controls.push({
      id: String(
        feature.properties?.id ??
          feature.properties?.code ??
          symbolType,
      ),
      code: String(
        feature.properties?.code ?? (symbolType === "start" ? "S" : "F"),
      ),
      type: symbolType,
      x,
      y,
      cuts: Array.isArray(feature.properties?.cuts)
        ? (feature.properties.cuts as Array<{ start: number; end: number }>)
        : undefined,
    });
  }
  return controls.sort((a, b) => {
    const order = { start: 0, control: 1, finish: 2 };
    return order[a.type] - order[b.type];
  });
}

export function courseGeometryLegs(geometry: unknown): CourseOverlayLeg[] {
  if (!geometry || typeof geometry !== "object") return [];
  const features = (geometry as { features?: unknown }).features;
  if (!Array.isArray(features)) return [];
  const legs: CourseOverlayLeg[] = [];
  for (const raw of features) {
    if (!raw || typeof raw !== "object") continue;
    const feature = raw as {
      geometry?: { type?: unknown; coordinates?: unknown };
      properties?: Record<string, unknown>;
    };
    const kind = feature.properties?.symbolType;
    if (
      feature.geometry?.type !== "LineString" ||
      (kind !== "leg" &&
        kind !== "marked_route" &&
        kind !== "forbidden_route" &&
        kind !== "restricted_line") ||
      !Array.isArray(feature.geometry.coordinates)
    ) {
      continue;
    }
    const points = feature.geometry.coordinates
      .filter((coordinate): coordinate is [unknown, unknown] =>
        Array.isArray(coordinate),
      )
      .map((coordinate) => ({
        x: Number(coordinate[0]),
        y: Number(coordinate[1]),
      }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (points.length < 2) continue;
    const rawGaps = feature.properties?.gaps;
    const gaps = Array.isArray(rawGaps)
      ? rawGaps
          .filter(
            (gap): gap is { from: number; to: number } =>
              typeof gap === "object" &&
              gap !== null &&
              typeof (gap as { from?: unknown }).from === "number" &&
              Number.isFinite((gap as { from: number }).from) &&
              typeof (gap as { to?: unknown }).to === "number" &&
              Number.isFinite((gap as { to: number }).to),
          )
          .map((gap) => ({ from: gap.from, to: gap.to }))
      : undefined;
    legs.push({
      points,
      kind,
      gaps,
      preclipped: feature.properties?.preclipped === true,
    });
  }
  return legs;
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

  const rawControls =
    input.kind === "all_controls"
      ? (input.allControls ?? []).filter(
          (control) => control.xpos !== 0 || control.ypos !== 0,
        )
      : input.course?.controls ?? [];
  const geometryControls =
    input.kind === "course"
      ? courseGeometryControls(input.course?.geometry)
      : [];
  const geometryByCode = new Map(
    geometryControls.map((control) => [control.code, control]),
  );
  const regularControls = rawControls.map((control) => {
    const code = control.codes.split(";")[0] || String(control.seq ?? "");
    const geometryControl = geometryByCode.get(code);
    const type: CourseOverlayControl["type"] =
      input.kind === "all_controls" &&
      (control.status === "start" || control.status === "finish")
        ? control.status
        : "control";
    return {
      id: control.id,
      code,
      type,
      x: geometryControl?.x ?? control.xpos,
      y: geometryControl?.y ?? control.ypos,
      cuts: geometryControl?.cuts,
      description: control.description,
    };
  });
  if (input.kind === "all_controls") {
    regularControls.sort((a, b) =>
      a.code.localeCompare(b.code, undefined, { numeric: true }),
    );
  }
  const controls: CourseOverlayControl[] =
    input.kind === "course"
      ? [
          ...geometryControls.filter((control) => control.type === "start"),
          ...regularControls.map(({ description: _description, ...rest }) => {
            void _description;
            return rest;
          }),
          ...geometryControls.filter((control) => control.type === "finish"),
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
    const finishGeom = geometryControls.find((c) => c.type === "finish");
    const lastControl = controlRows[controlRows.length - 1];
    const finishLengthM =
      finishGeom && lastControl && input.mapScale
        ? (Math.hypot(finishGeom.x - lastControl.x, finishGeom.y - lastControl.y) *
            input.mapScale) /
          1000
        : null;
    const sheet = buildDescriptionSheet({
      eventName: input.event?.name ?? "",
      classNames: input.course.classes?.map((c) => c.name) ?? [],
      courseName: input.course.name,
      lengthM: input.course.lengthM,
      climbM: input.course.climbM,
      controls: controlRows.map((control, index) => {
        const source = rawControls[regularControls.indexOf(control)];
        return {
          id: source?.seq ?? index + 1,
          code: control.code,
          description: (control.description ?? null) as ControlDescription | null,
        };
      }),
      instructions: readInstructions(input.course.descriptionInstructions),
      finishLengthM,
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

  const legs =
    input.kind === "course"
      ? courseGeometryLegs(input.course?.geometry)
      : [];
  if (
    input.kind === "course" &&
    !legs.some((leg) => (leg.kind ?? "leg") === "leg")
  ) {
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

  const center =
    input.windowCenter ??
    centerOfControls(controls) ?? {
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
    descriptionRows,
    descriptionHeader,
    overprintScale: (input.mapScale ?? printScale) / printScale,
    textValues: {
      event: input.event?.name ?? "",
      course: course?.name ?? "",
      map: input.mapName ?? "",
      variant: "",
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
