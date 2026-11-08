import {
  getPaperDimensions,
  pointInWindow,
  rectInside,
  type PaperDimensions,
} from "./geometry.js";
import { descriptionBlockSize } from "./description-rows.js";
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
  /** Header rows above the description rows (1 title row, or 3 for the IOF header). */
  descriptionHeaderRows?: number;
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

/** A layout object's bounds on the page (page mm, y-down): every layout object is page-anchored since F12. */
export function courseMapObjectPageBounds(object: CourseMapObject): MapRect {
  switch (object.kind) {
    case "text": {
      const width =
        object.maxWidthMm ??
        Math.max(object.fontSizeMm, object.text.length * object.fontSizeMm * 0.55);
      const align = object.align ?? "left";
      return {
        x:
          align === "center"
            ? object.x - width / 2
            : align === "right"
              ? object.x - width
              : object.x,
        y: object.y - object.fontSizeMm,
        width,
        height: object.fontSizeMm * 1.25,
      };
    }
    case "line":
      return {
        x: Math.min(object.x1, object.x2),
        y: Math.min(object.y1, object.y2),
        width: Math.max(Math.abs(object.x2 - object.x1), 0.001),
        height: Math.max(Math.abs(object.y2 - object.y1), 0.001),
      };
    case "rectangle":
    case "image":
      return { x: object.x, y: object.y, width: object.width, height: object.height };
    case "path": {
      const points = object.points.flatMap((point) => [
        point,
        ...(point.hIn
          ? [{ x: point.x + point.hIn.x, y: point.y + point.hIn.y }]
          : []),
        ...(point.hOut
          ? [{ x: point.x + point.hOut.x, y: point.y + point.hOut.y }]
          : []),
      ]);
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
      options.descriptionHeaderRows ?? 1,
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
    const bounds = courseMapObjectPageBounds(object);
    if (!rectInside(bounds, printable)) {
      issues.push({
        code: "object_outside_page",
        message: `Layout object ${object.id} extends outside the printable margin`,
        objectId: object.id,
      });
    }
  }

  return { valid: issues.length === 0, issues };
}
