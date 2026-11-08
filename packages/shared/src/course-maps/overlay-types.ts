import type { MapPoint } from "./schema.js";
import type { FractionGap } from "./overlay-geometry.js";

/**
 * The resolved course overlay of a sheet as the API's `resolve-layout.ts`
 * answers it (controls in map mm, legs with their gaps). Course mode and
 * print draw the course through `courseLayer()`; these shapes outlived the
 * SVG overlay emitter (deleted in E4c) as the layout read's wire types.
 */
export interface CircleCut {
  start: number;
  end: number;
}

export interface CourseOverlayControl extends MapPoint {
  id: string;
  code: string;
  /** How the site is drawn; an all-controls sheet types its sites by kind (crossing and map-issue points, course-layer.md §10.3). */
  type: "start" | "control" | "finish" | "crossing_point" | "map_issue";
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
