import { mapToPage, windowRotationDeg } from "./geometry.js";
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
   * Enlargement factor `mapScale / printScale`. ISOM specifies overprint
   * dimensions at the base map scale (circle Ø 5–6 mm, 0.35 mm lines at
   * 1:15000); when the map is printed enlarged the overprint must enlarge
   * with it, so all appearance dimensions are multiplied by this factor.
   * Default 1 (printed at map scale).
   */
  overprintScale?: number;
}

export function renderCourseOverlaySvg(
  options: RenderCourseOverlayOptions,
): string {
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
  // Arial, non-bold). SVG font-size is the em box, and Liberation Sans
  // (metrically Arial-compatible) has cap/digit height 1409/2048 of the
  // em, so scale up to make the printed digits measure `labelSize` mm.
  const labelFontSize = labelSize / (1409 / 2048);
  const startSize = 3.5 * enlarge;
  const finishInner = 2 * enlarge;
  const finishOuter = 3 * enlarge;
  const controls = options.controls.map((control) => ({
    control,
    point: mapToPage(control, frame, window),
  }));
  const obstacles = controls.map(({ point }) => point);
  const drawnSegments: OverlaySegment[] = [];
  const parts: string[] = [
    `<g data-map-layer="course-overlay" fill="none" stroke="${purple}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" opacity="0.85" style="mix-blend-mode: multiply">`,
  ];

  for (const leg of options.legs) {
    if (leg.points.length < 2) continue;
    const points = leg.points.map((point) => mapToPage(point, frame, window));
    const kind = leg.kind ?? (leg.dashed ? "forbidden_route" : "leg");
    if (kind !== "leg") {
      const path = points
        .map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`)
        .join(" ");
      const width = kind === "marked_route" ? stroke * 1.5 : stroke * 2;
      const dash =
        kind === "marked_route"
          ? `${stroke * 4} ${stroke * 2}`
          : kind === "forbidden_route"
            ? `${stroke * 6} ${stroke * 3}`
            : null;
      parts.push(
        `<path d="${path}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`,
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
        parts.push(`<path d="${path}"/>`);
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
          parts.push(
            `<line x1="${segment.x1}" y1="${segment.y1}" x2="${segment.x2}" y2="${segment.y2}"${leg.gaps?.length ? ' data-leg-gapped="true"' : ""}/>`,
          );
          drawnSegments.push(segment);
        }
      }
    }
  }

  const placementCircles: PlacementCircle[] = [];
  let sequence = 0;
  for (const { control, point } of controls) {
    const value =
      control.type === "control"
        ? options.allControls
          ? control.code
          : String(++sequence)
        : undefined;
    placementCircles.push({
      id: control.id,
      x: point.x,
      y: point.y,
      label: value,
      radius:
        control.type === "start"
          ? startSize
          : control.type === "finish"
            ? finishOuter
            : radius,
    });
  }
  const labels = placeControlLabels(placementCircles, drawnSegments, {
    radius,
    labelSize: labelFontSize,
  });

  for (const { control, point } of controls) {
    const data = `data-control-id="${escapeSvgText(control.id)}" data-control-code="${escapeSvgText(control.code)}"`;
    if (control.type === "start") {
      parts.push(
        `<path ${data} d="M${point.x},${point.y - startSize} L${point.x - startSize * 0.866},${point.y + startSize * 0.5} L${point.x + startSize * 0.866},${point.y + startSize * 0.5} Z"/>`,
      );
      continue;
    }
    if (control.type === "finish") {
      parts.push(
        `<circle ${data} cx="${point.x}" cy="${point.y}" r="${finishOuter}"/>`,
        `<circle ${data} cx="${point.x}" cy="${point.y}" r="${finishInner}"/>`,
      );
      continue;
    }

    // Cut gaps are authored relative to map north; when the window is
    // rotated for display north the gaps rotate with the map features.
    const rotation = windowRotationDeg(window);
    const cuts = (control.cuts ?? []).map((cut) =>
      rotation === 0
        ? cut
        : { start: cut.start + rotation, end: cut.end + rotation },
    );
    parts.push(
      `<path ${data} d="${drawBrokenCircle(point.x, point.y, radius, cuts)}"/>`,
    );
    const label =
      control.labelPosition === undefined
        ? labels.get(control.id)
        : {
            ...mapToPage(control.labelPosition, frame, window),
            w: labelFontSize,
            h: labelFontSize,
          };
    if (!label) continue;
    if (label.leader) {
      parts.push(
        `<line data-control-label-leader="${escapeSvgText(control.id)}" x1="${label.leader.x1}" y1="${label.leader.y1}" x2="${label.leader.x2}" y2="${label.leader.y2}" stroke-width="${stroke * 0.7}"/>`,
      );
    }
    const placement = placementCircles.find((circle) => circle.id === control.id);
    // ISOM 704: Arial, non-bold.
    parts.push(
      `<text x="${label.x}" y="${label.y}" fill="${purple}" stroke="none" font-family="Liberation Sans, Arial, sans-serif" font-size="${labelFontSize}" text-anchor="middle" dominant-baseline="central">${escapeSvgText(placement?.label ?? control.code)}</text>`,
    );
  }

  parts.push("</g>");
  return parts.join("");
}
