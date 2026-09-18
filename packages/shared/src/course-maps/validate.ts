import {
  getPaperDimensions,
  mapToPage,
  pointInWindow,
  rectInside,
  type PaperDimensions,
} from "./geometry.js";
import { descriptionBlockSize } from "./description-svg.js";
import type {
  CourseMapDocument,
  CourseMapObject,
  MapPoint,
  MapRect,
  MapWindow,
} from "./schema.js";

export type CourseMapValidationCode =
  | "map_scale_missing"
  | "control_outside_frame"
  | "description_outside_page"
  | "object_outside_page";

export interface CourseMapValidationIssue {
  code: CourseMapValidationCode;
  message: string;
  controlId?: string;
  objectId?: string;
  variantKey?: string;
}

export interface CourseMapVariant {
  key: string;
  controls: Array<MapPoint & { id: string; code: string }>;
}

export interface ValidateCourseMapOptions {
  document: CourseMapDocument;
  mapScale: number | null;
  window?: MapWindow;
  /** All maps for this course family, used to validate fork coverage. */
  windows?: MapWindow[];
  variants: CourseMapVariant[];
  descriptionRowCount?: number;
}

export function printablePageRect(document: CourseMapDocument): MapRect {
  const paper = paperFor(document);
  const margin = document.printMarginMm;
  return {
    x: margin,
    y: margin,
    width: Math.max(0.001, paper.width - margin * 2),
    height: Math.max(0.001, paper.height - margin * 2),
  };
}

export function courseMapObjectPageBounds(
  object: CourseMapObject,
  frame: MapRect,
  window?: MapWindow,
): MapRect | null {
  const pointFor = (point: MapPoint): MapPoint | null =>
    object.anchor === "page"
      ? point
      : window
        ? mapToPage(point, frame, window)
        : null;
  switch (object.kind) {
    case "text": {
      const point = pointFor({ x: object.x, y: object.y });
      if (!point) return null;
      const width =
        object.maxWidthMm ??
        Math.max(object.fontSizeMm, object.text.length * object.fontSizeMm * 0.55);
      const align = object.align ?? "left";
      return {
        x:
          align === "center"
            ? point.x - width / 2
            : align === "right"
              ? point.x - width
              : point.x,
        y: point.y - object.fontSizeMm,
        width,
        height: object.fontSizeMm * 1.25,
      };
    }
    case "line": {
      const start = pointFor({ x: object.x1, y: object.y1 });
      const end = pointFor({ x: object.x2, y: object.y2 });
      if (!start || !end) return null;
      return {
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.max(Math.abs(end.x - start.x), 0.001),
        height: Math.max(Math.abs(end.y - start.y), 0.001),
      };
    }
    case "rectangle":
    case "image": {
      if (object.anchor === "page") return object;
      if (!window) return null;
      const topLeft = mapToPage(
        { x: object.x, y: object.y + object.height },
        frame,
        window,
      );
      return {
        x: topLeft.x,
        y: topLeft.y,
        width: (object.width / window.width) * frame.width,
        height: (object.height / window.height) * frame.height,
      };
    }
    case "path": {
      const nativePoints = object.points.flatMap((point) => [
        point,
        ...(point.hIn
          ? [{ x: point.x + point.hIn.x, y: point.y + point.hIn.y }]
          : []),
        ...(point.hOut
          ? [{ x: point.x + point.hOut.x, y: point.y + point.hOut.y }]
          : []),
      ]);
      const points = nativePoints
        .map(pointFor)
        .filter((point): point is MapPoint => point !== null);
      if (points.length !== nativePoints.length) return null;
      const xs = points.map((point) => point.x);
      const ys = points.map((point) => point.y);
      return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(Math.max(...xs) - Math.min(...xs), 0.001),
        height: Math.max(Math.max(...ys) - Math.min(...ys), 0.001),
      };
    }
  }
}

function paperFor(document: CourseMapDocument): PaperDimensions {
  return getPaperDimensions(
    document.paper,
    document.orientation,
    document.paper === "custom"
      ? {
          width: document.paperWidthMm!,
          height: document.paperHeightMm!,
        }
      : undefined,
  );
}

export function validateCourseMap(
  options: ValidateCourseMapOptions,
): { valid: boolean; issues: CourseMapValidationIssue[] } {
  const issues: CourseMapValidationIssue[] = [];
  if (options.mapScale === null || options.mapScale <= 0) {
    issues.push({
      code: "map_scale_missing",
      message: "The base map has no usable scale",
    });
  }

  const windows = options.windows ?? (options.window ? [options.window] : []);
  for (const variant of options.variants) {
    for (const control of variant.controls) {
      if (!windows.some((window) => pointInWindow(control, window))) {
        issues.push({
          code: "control_outside_frame",
          message: `Control ${control.code} is outside every map frame`,
          controlId: control.id,
          variantKey: variant.key || undefined,
        });
      }
    }
  }

  const printable = printablePageRect(options.document);
  if (options.document.description.visible) {
    const size = descriptionBlockSize(
      options.descriptionRowCount ??
        Math.max(0, ...options.variants.map((variant) => variant.controls.length)),
      options.document.description.cellSizeMm,
    );
    if (
      !rectInside(
        {
          x: options.document.description.x,
          y: options.document.description.y,
          ...size,
        },
        printable,
      )
    ) {
      issues.push({
        code: "description_outside_page",
        message: "The control description block extends outside the printable margin",
      });
    }
  }

  for (const object of options.document.objects) {
    // Map-anchored objects follow the terrain and are clipped to the map
    // frame when printed, so ending up (partly) outside the printable area
    // after moving the window is by design — nothing wrong to report.
    if (object.anchor === "map") continue;
    const bounds = courseMapObjectPageBounds(
      object,
      options.document.mapFrame,
      options.window,
    );
    if (bounds && !rectInside(bounds, printable)) {
      issues.push({
        code: "object_outside_page",
        message: `Layout object ${object.id} extends outside the printable margin`,
        objectId: object.id,
      });
    }
  }

  return { valid: issues.length === 0, issues };
}
