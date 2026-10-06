import { mapToPage, rotatePagePoint, windowRotationDeg } from "./geometry.js";
import type { MapAppearance, MapPoint, MapRect, MapWindow } from "./schema.js";
import { escapeSvgText } from "./text.js";
import {
  clipLine,
  drawBrokenCircle,
  subtractLegGaps,
  type FractionGap,
  type OverlaySegment,
} from "./overlay-geometry.js";
import {
  placeControlLabels,
  type PlacementCircle,
} from "./control-label-placement.js";

export interface CircleCut {
  start: number;
  end: number;
}

export interface CourseOverlayControl extends MapPoint {
  id: string;
  code: string;
  type: "start" | "control" | "finish";
  cuts?: CircleCut[];
  labelPosition?: MapPoint;
}

export interface CourseOverlayLeg {
  points: MapPoint[];
  dashed?: boolean;
  gaps?: FractionGap[];
  preclipped?: boolean;
  kind?: "leg" | "marked_route" | "forbidden_route" | "restricted_line";
}

export interface RenderCourseOverlayOptions {
  frame: MapRect;
  window: MapWindow;
  appearance: MapAppearance;
  controls: CourseOverlayControl[];
  legs: CourseOverlayLeg[];
  allControls?: boolean;
  /**
   * How control numbers are labelled. Defaults to `"code"` when
   * `allControls` is set, otherwise `"sequence"`. Free-order course maps
   * pass `"code"` explicitly so punch codes replace 1,2,3…
   */
  labelMode?: "sequence" | "code";
  /**
   * Enlargement factor `mapScale / printScale`. ISOM specifies overprint
   * dimensions at the base map scale (circle Ø 5–6 mm, 0.35 mm lines at
   * 1:15000); when the map is printed enlarged the overprint must enlarge
   * with it, so all appearance dimensions are multiplied by this factor.
   * Default 1 (printed at map scale).
   */
  overprintScale?: number;
}

export interface CourseOverlayLayers {
  /** 701/703/705/706/708 — sits under the map ink layer. */
  lower: string;
  /** 704/707/714 — sits above the map ink layer. */
  upper: string;
}

/**
 * Cap/digit height of Liberation Sans (metrically Arial-compatible) as a
 * fraction of the em box: 1409/2048. ISOM 704 specifies the control
 * number by digit height, SVG `font-size` is the em box, so
 * `font-size = digitHeight / CONTROL_NUMBER_CAP_HEIGHT_RATIO`.
 */
export const CONTROL_NUMBER_CAP_HEIGHT_RATIO = 1409 / 2048;

/** Font stack for control numbers — identical in print and on screen. */
export const CONTROL_NUMBER_FONT_FAMILY = "Liberation Sans, Arial, sans-serif";

/**
 * Baseline `y` that puts the visual centre of a digit at `centerY`.
 *
 * Digits span from the alphabetic baseline up to the cap height, so the
 * centre of the glyph is half a digit height above the baseline. This is
 * used instead of `dominant-baseline="central"`, which librsvg (the PDF
 * converter) does not implement — with it, browsers centred the number
 * while the PDF rendered it half a digit higher.
 */
export function controlNumberBaselineY(
  centerY: number,
  digitHeight: number,
): number {
  return centerY + digitHeight / 2;
}

function openGroup(layer: "lower" | "upper", purple: string, stroke: number): string {
  return `<g data-map-layer="course-overlay-${layer}" fill="none" stroke="${purple}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">`;
}

/**
 * Render the course overprint as two SVG groups so the caller can
 * interleave the map's above-purple ink layer between them (IOF digital
 * print stacking). No opacity or blend mode — stacking handles visibility.
 */
export function renderCourseOverlaySvg(
  options: RenderCourseOverlayOptions,
): CourseOverlayLayers {
  const { appearance, frame, window } = options;
  const enlarge =
    options.overprintScale !== undefined &&
    Number.isFinite(options.overprintScale) &&
    options.overprintScale > 0
      ? options.overprintScale
      : 1;
  const purple = appearance.purple;
  const stroke = appearance.lineWidthMm * enlarge;
  const radius = appearance.circleRadiusMm * enlarge;
  const labelSize = appearance.numberHeightMm * enlarge;
  // ISOM 704 gives the control-number size as the digit height (4.0 mm,
  // Arial, non-bold). SVG font-size is the em box, so scale up to make
  // the printed digits measure `labelSize` mm.
  const labelFontSize = labelSize / CONTROL_NUMBER_CAP_HEIGHT_RATIO;
  // A narrow opaque knockout keeps purple numbers readable over dense map
  // ink without turning them into large white labels.
  const labelHaloWidth = labelFontSize * 0.12;
  const startSize = 3.5 * enlarge;
  const finishInner = 2 * enlarge;
  const finishOuter = 3 * enlarge;
  const controls = options.controls.map((control) => ({
    control,
    point: mapToPage(control, frame, window),
  }));
  const obstacles = controls.map(({ point }) => point);
  const drawnSegments: OverlaySegment[] = [];
  const lower: string[] = [openGroup("lower", purple, stroke)];
  const upper: string[] = [openGroup("upper", purple, stroke)];

  for (const leg of options.legs) {
    if (leg.points.length < 2) continue;
    const points = leg.points.map((point) => mapToPage(point, frame, window));
    const kind = leg.kind ?? (leg.dashed ? "forbidden_route" : "leg");

    // Upper purple: marked route (707), forbidden route (714).
    if (kind === "marked_route" || kind === "forbidden_route") {
      const path = points
        .map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`)
        .join(" ");
      const width = kind === "marked_route" ? stroke * 1.5 : stroke * 2;
      const dash =
        kind === "marked_route"
          ? `${stroke * 4} ${stroke * 2}`
          : `${stroke * 6} ${stroke * 3}`;
      upper.push(
        `<path d="${path}" stroke-width="${width}" stroke-dasharray="${dash}"/>`,
      );
      for (let index = 0; index < points.length - 1; index += 1) {
        drawnSegments.push({
          x1: points[index].x,
          y1: points[index].y,
          x2: points[index + 1].x,
          y2: points[index + 1].y,
        });
      }
      continue;
    }

    // Lower purple: course legs (705) and restricted lines (708).
    if (kind === "restricted_line") {
      const path = points
        .map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`)
        .join(" ");
      lower.push(`<path d="${path}" stroke-width="${stroke * 2}"/>`);
      for (let index = 0; index < points.length - 1; index += 1) {
        drawnSegments.push({
          x1: points[index].x,
          y1: points[index].y,
          x2: points[index + 1].x,
          y2: points[index + 1].y,
        });
      }
      continue;
    }

    const pieces =
      leg.preclipped || !leg.gaps?.length
        ? [points]
        : subtractLegGaps(points, leg.gaps);
    for (const piece of pieces) {
      if (leg.preclipped) {
        const path = piece
          .map(
            (point, index) =>
              `${index === 0 ? "M" : "L"}${point.x},${point.y}`,
          )
          .join(" ");
        lower.push(`<path d="${path}"/>`);
        for (let index = 0; index < piece.length - 1; index += 1) {
          drawnSegments.push({
            x1: piece[index].x,
            y1: piece[index].y,
            x2: piece[index + 1].x,
            y2: piece[index + 1].y,
          });
        }
        continue;
      }
      for (let index = 0; index < piece.length - 1; index += 1) {
        const segments = clipLine(
          piece[index],
          piece[index + 1],
          obstacles,
          radius * 1.2,
        );
        for (const segment of segments) {
          lower.push(
            `<line x1="${segment.x1}" y1="${segment.y1}" x2="${segment.x2}" y2="${segment.y2}"${leg.gaps?.length ? ' data-leg-gapped="true"' : ""}/>`,
          );
          drawnSegments.push(segment);
        }
      }
    }
  }

  // Auto-placement runs in the MAP frame (page coordinates with the
  // window rotation undone), not in page coordinates: the course editor,
  // the layout preview and the PDF may each show the course under a
  // different rotation, and a number must land on the same spot on the
  // map in all of them. Rotation about the frame centre is rigid, so the
  // clipped segments can simply be rotated back; only the chosen label
  // centres (and leaders) are rotated onto the page afterwards.
  const rotation = windowRotationDeg(window);
  const frameCenter = {
    x: frame.x + frame.width / 2,
    y: frame.y + frame.height / 2,
  };
  const toMapFrame = (point: MapPoint): MapPoint =>
    rotation === 0 ? point : rotatePagePoint(point, frameCenter, -rotation);
  const toPageFrame = (point: MapPoint): MapPoint =>
    rotation === 0 ? point : rotatePagePoint(point, frameCenter, rotation);

  const labelMode =
    options.labelMode ?? (options.allControls ? "code" : "sequence");
  const placementCircles: PlacementCircle[] = [];
  let sequence = 0;
  for (const { control, point } of controls) {
    const value =
      control.type === "control"
        ? labelMode === "code"
          ? control.code
          : String(++sequence)
        : undefined;
    const framePoint = toMapFrame(point);
    placementCircles.push({
      id: control.id,
      x: framePoint.x,
      y: framePoint.y,
      label: value,
      radius:
        control.type === "start"
          ? startSize
          : control.type === "finish"
            ? finishOuter
            : radius,
      ...(control.labelPosition !== undefined
        ? {
            fixedLabel: toMapFrame(
              mapToPage(control.labelPosition, frame, window),
            ),
          }
        : {}),
    });
  }
  const placementSegments = drawnSegments.map((segment) => {
    const a = toMapFrame({ x: segment.x1, y: segment.y1 });
    const b = toMapFrame({ x: segment.x2, y: segment.y2 });
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  });
  const labels = placeControlLabels(placementCircles, placementSegments, {
    radius,
    labelSize: labelFontSize,
  });

  for (const { control, point } of controls) {
    const data = `data-control-id="${escapeSvgText(control.id)}" data-control-code="${escapeSvgText(control.code)}"`;
    if (control.type === "start") {
      lower.push(
        `<path ${data} d="M${point.x},${point.y - startSize} L${point.x - startSize * 0.866},${point.y + startSize * 0.5} L${point.x + startSize * 0.866},${point.y + startSize * 0.5} Z"/>`,
      );
      continue;
    }
    if (control.type === "finish") {
      lower.push(
        `<circle ${data} cx="${point.x}" cy="${point.y}" r="${finishOuter}"/>`,
        `<circle ${data} cx="${point.x}" cy="${point.y}" r="${finishInner}"/>`,
      );
      continue;
    }

    // Cut gaps are authored relative to map north; when the window is
    // rotated for display north the gaps rotate with the map features.
    const cuts = (control.cuts ?? []).map((cut) =>
      rotation === 0
        ? cut
        : { start: cut.start + rotation, end: cut.end + rotation },
    );
    lower.push(
      `<path ${data} d="${drawBrokenCircle(point.x, point.y, radius, cuts)}"/>`,
    );
    const placed = labels.get(control.id);
    if (!placed) continue;
    const label = toPageFrame(placed);
    if (placed.leader) {
      const from = toPageFrame({ x: placed.leader.x1, y: placed.leader.y1 });
      const to = toPageFrame({ x: placed.leader.x2, y: placed.leader.y2 });
      upper.push(
        `<line data-control-label-leader="${escapeSvgText(control.id)}" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke-width="${stroke * 0.7}"/>`,
      );
    }
    const placement = placementCircles.find((circle) => circle.id === control.id);
    // ISOM 704: Arial, non-bold — upper purple with a narrow white
    // knockout so numbers stay legible over map ink. The anchor is the
    // alphabetic baseline (no dominant-baseline: librsvg ignores it), so
    // shift down by half a digit so the glyph is centred on `label`.
    upper.push(
      `<text data-control-label="${escapeSvgText(control.id)}" x="${label.x}" y="${controlNumberBaselineY(label.y, labelSize)}" fill="${purple}" stroke="#fff" stroke-width="${labelHaloWidth}" stroke-linejoin="round" paint-order="stroke fill" font-family="${CONTROL_NUMBER_FONT_FAMILY}" font-size="${labelFontSize}" text-anchor="middle">${escapeSvgText(placement?.label ?? control.code)}</text>`,
    );
  }

  lower.push("</g>");
  upper.push("</g>");
  return { lower: lower.join(""), upper: upper.join("") };
}
