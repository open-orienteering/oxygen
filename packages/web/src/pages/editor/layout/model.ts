/**
 * Layout mode's model (docs/course-layout.md §2): the sheet or template
 * being edited as one snapshot — what one gesture changes and one write
 * stores — and everything drawn from it: the page geometry, the page
 * request the GL layer draws (the composer's input), the editable and
 * locked objects of the scope.
 */

import {
  course,
  getPaperDimensions,
  type CourseMapObject,
  type DescriptionBlockSettings,
  type MapRect,
  type MapTemplateSettings,
} from "@oxygen/shared";
import type { LayoutRequest } from "../../../lib/course-layer-request";
import { sheetWindow, windowCentre, type SheetGeometry } from "../../../lib/editor/layout";
import { createImageObjectAt, createObjectAt, fillModePatch } from "../../../lib/map-layout-editor";
import type { PlaceKind } from "./bindings";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@oxygen/api";

type Pt = { x: number; y: number };

/** The header text's size on paper (the rail's `H`). */
export const HEADER_SIZE_MM = 6;

export type EditorSheet = inferRouterOutputs<AppRouter>["courseMap"]["resolveSheet"];

/** What a Layout gesture edits; sheet scope stores it with `courseMap.saveLayout`, template scope with `mapTemplate.update`. */
export interface LayoutSnapshot {
  /** The window centre, paper mm (sheet scope: stored; template scope: the preview's, never stored). */
  centre: Pt;
  printScale: number;
  description: DescriptionBlockSettings;
  sheetObjects: CourseMapObject[];
  templateObjects: CourseMapObject[];
  /** Template scope's page settings (sheet scope: the template's, read-only). */
  paper: string;
  orientation: string;
  paperWidthMm: number | null;
  paperHeightMm: number | null;
  settings: MapTemplateSettings;
}

/** The snapshot of what the server holds. */
export function snapshotOf(s: EditorSheet): LayoutSnapshot {
  const t = s.template;
  return {
    centre: windowCentre(s.window),
    printScale: s.scope === "sheet" ? s.sheet?.overrides.printScale ?? t.printScale : t.printScale,
    description: s.scope === "sheet" ? s.document.description : t.settings.description,
    sheetObjects: s.sheet?.objects ?? [],
    templateObjects: t.objects,
    paper: t.paper,
    orientation: t.orientation,
    paperWidthMm: t.paperWidthMm,
    paperHeightMm: t.paperHeightMm,
    settings: t.settings,
  };
}

/** The frame: the sheet's override, else the template's. */
export function frameOf(s: EditorSheet, snap: LayoutSnapshot): MapRect {
  return (s.scope === "sheet" ? s.sheet?.overrides.mapFrame : undefined) ?? snap.settings.mapFrame;
}

export function geometryOf(s: EditorSheet, snap: LayoutSnapshot): SheetGeometry {
  const paper = getPaperDimensions(
    snap.paper as "A4",
    snap.orientation as "portrait",
    snap.paper === "custom" ? { width: snap.paperWidthMm ?? 210, height: snap.paperHeightMm ?? 297 } : undefined,
  );
  const m = snap.settings.printMarginMm;
  const frame = frameOf(s, snap);
  return {
    paper: { widthMm: paper.width, heightMm: paper.height },
    printable: { x: m, y: m, width: Math.max(0.001, paper.width - 2 * m), height: Math.max(0.001, paper.height - 2 * m) },
    frame,
    window: sheetWindow(frame, snap.centre, s.mapScale, snap.printScale, s.window.rotationDeg ?? 0),
  };
}

/** The objects a gesture may change (the scope's own) and the ones drawn but locked (the template's, in sheet scope). */
export function scopeObjects(s: EditorSheet, snap: LayoutSnapshot): { editable: CourseMapObject[]; locked: CourseMapObject[] } {
  return s.scope === "sheet" ? { editable: snap.sheetObjects, locked: snap.templateObjects } : { editable: snap.templateObjects, locked: [] };
}

/** The snapshot with the scope's editable objects replaced. */
export function withEditable(s: EditorSheet, snap: LayoutSnapshot, objects: CourseMapObject[]): LayoutSnapshot {
  return s.scope === "sheet" ? { ...snap, sheetObjects: objects } : { ...snap, templateObjects: objects };
}

/**
 * The sheet as the course layer and the page part draw it (the composer's
 * input, `resolveSheet`): layout objects of both scopes, the scale's text
 * value and overprint, the block where the snapshot puts it.
 */
export function layoutRequestOf(s: EditorSheet, snap: LayoutSnapshot, g: SheetGeometry): LayoutRequest {
  const d = snap.description;
  return {
    page: {
      paper: { heightMm: g.paper.heightMm },
      frame: g.frame,
      window: g.window,
      objects: [...snap.templateObjects, ...snap.sheetObjects],
      textValues: { ...s.page.textValues, scale: `1:${snap.printScale}` },
      description: d.visible ? { x: d.x, y: d.y, cellSizeMm: d.cellSizeMm, rows: s.block.rows, header: s.block.header, title: s.block.title } : null,
    },
    appearance: course.appearanceFromTemplate(snap.settings.appearance),
    overprintScale: (s.mapScale ?? snap.printScale) / snap.printScale,
  };
}

/**
 * A new object of a rail tool at a page point (docs/course-layout.md §3),
 * clamped to the printable area by `lib/map-layout-editor.ts`'s creators.
 * The block is not an object: the rail's `D` shows it (`description`).
 */
export function placeObject(what: Exclude<PlaceKind, "description">, at: Pt, printable: MapRect, purple: string, graphicId?: number): CourseMapObject | null {
  switch (what) {
    case "header": {
      const o = createObjectAt("text", at, printable);
      return o.kind === "text" ? { ...o, fontSizeMm: HEADER_SIZE_MM } : o;
    }
    case "text":
      return createObjectAt("text", at, printable);
    case "image":
      return graphicId === undefined ? null : createImageObjectAt(graphicId, at, printable);
    case "whiteout": {
      const o = createObjectAt("rectangle", at, printable);
      if (o.kind !== "rectangle") return o;
      // A white-out has no border.
      const { stroke: _stroke, strokeWidthMm: _width, ...plain } = o;
      return { ...plain, fillMode: "whiteout" };
    }
    case "whiteoutOutside": {
      const o = createObjectAt("path", at, printable);
      // fillModePatch closes the path for an area fill.
      return o.kind === "path" ? { ...o, ...(fillModePatch(o, "whiteoutInverted", purple) as Partial<typeof o>) } : o;
    }
    case "line":
    case "rectangle":
    case "path":
      return createObjectAt(what, at, printable);
  }
}
