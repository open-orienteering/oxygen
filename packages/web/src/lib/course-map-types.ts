/**
 * A new template's form draft and its `mapTemplate.create` payload
 * (`components/NewTemplateForm.tsx`; E-pages).
 */

import {
  defaultMapAppearance,
  defaultMapFrame,
  getPaperDimensions,
} from "@oxygen/shared";

export type MapPaper = "A3" | "A4" | "A5";
export type MapOrientation = "portrait" | "landscape";

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

export function templatePayload(draft: TemplateDraft) {
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
      description: {
        visible: true,
        x: Math.max(margin, dimensions.width - margin - 48),
        y: margin + 4,
        cellSizeMm: 6,
      },
      appearance: defaultMapAppearance,
    },
    objects: [],
  };
}
