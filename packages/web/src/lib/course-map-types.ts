import {
  defaultMapAppearance,
  defaultMapFrame,
  getPaperDimensions,
  type CourseMapDocument,
  type CourseMapObject,
  type CourseMapOverrides,
  type CourseOverlayControl,
  type CourseOverlayLeg,
  type DescriptionRow,
  type DescriptionSheetHeader,
  type MapTemplateSettings,
  type MapTextValues,
  type MapWindow,
} from "@oxygen/shared";

export type MapPaper = "A3" | "A4" | "A5";
export type MapOrientation = "portrait" | "landscape";

export interface MapTemplateView {
  id: string;
  seq: number;
  name: string;
  paper: string;
  orientation: string;
  paperWidthMm?: number | null;
  paperHeightMm?: number | null;
  printScale: number;
  settings: MapTemplateSettings;
  objects: CourseMapObject[];
}

export interface CourseMapView {
  id: string;
  seq: number;
  name: string;
  kind: string;
  courseId: number | null;
  templateId: number | null;
  course: {
    seq: number;
    name: string;
    lengthM?: number;
    climbM?: number;
    classes?: Array<{ name: string }>;
  } | null;
  template: { seq: number; name: string } | null;
  overrides: CourseMapOverrides;
  objects: CourseMapObject[];
  controls: CourseOverlayControl[];
  legs: CourseOverlayLeg[];
  descriptionRows: DescriptionRow[];
  /** IOF 3-row header for course maps; null/undefined → single title row. */
  descriptionHeader?: DescriptionSheetHeader | null;
  validation: {
    valid: boolean;
    issues: Array<{
      code: string;
      controlId?: string;
      objectId?: string;
      message?: string;
    }>;
  };
  resolved: { document: CourseMapDocument; window: MapWindow } | null;
}

export interface TemplateLayoutPreview {
  document: CourseMapDocument;
  window: MapWindow;
  controls: CourseOverlayControl[];
  legs: CourseOverlayLeg[];
  descriptionRows: DescriptionRow[];
  descriptionHeader?: DescriptionSheetHeader | null;
  textValues: MapTextValues;
}

export interface TemplateDraft {
  name: string;
  paper: MapPaper;
  orientation: MapOrientation;
  printScale: string;
  margin: string;
}

export const EMPTY_TEMPLATE_DRAFT: TemplateDraft = {
  name: "",
  paper: "A4",
  orientation: "portrait",
  printScale: "7500",
  margin: "3",
};

export function draftFromTemplate(template: MapTemplateView): TemplateDraft {
  return {
    name: template.name,
    paper:
      template.paper === "A3" || template.paper === "A5"
        ? template.paper
        : "A4",
    orientation:
      template.orientation === "landscape" ? "landscape" : "portrait",
    printScale: String(template.printScale),
    margin: String(template.settings.printMarginMm),
  };
}

export function templatePayload(
  draft: TemplateDraft,
  existing?: MapTemplateView,
) {
  const printScale = Math.max(
    1_000,
    Math.min(100_000, Number.parseInt(draft.printScale, 10) || 7_500),
  );
  const margin = Math.max(
    0,
    Math.min(50, Number.parseFloat(draft.margin) || 0),
  );
  const dimensions = getPaperDimensions(draft.paper, draft.orientation);
  return {
    name: draft.name.trim(),
    paper: draft.paper,
    orientation: draft.orientation,
    printScale,
    settings: {
      printMarginMm: margin,
      mapFrame: defaultMapFrame(dimensions, margin),
      description: existing?.settings.description ?? {
        visible: true,
        x: Math.max(margin, dimensions.width - margin - 48),
        y: margin + 4,
        cellSizeMm: 6,
      },
      appearance: existing?.settings.appearance ?? defaultMapAppearance,
    },
    objects: existing?.objects ?? [],
  };
}
