/**
 * Templates by key (docs/course-layout.md §5; research 08 §4.6, 09 §5):
 * a template's `auto_key` is its `(paper, orientation, print scale)`; of
 * several templates sharing a key one is the **auto** template the editor
 * creates and assigns, the others are **extra** (decision (3), user
 * 2026-10-31: the one with the most sheets, ties to the oldest).
 */

import { defaultMapFrame, getPaperDimensions, type PaperDimensions } from "./geometry.js";
import { defaultMapAppearance, type MapAppearance, type MapTemplateSettings, type PaperOrientation, type PaperSize } from "./schema.js";

export interface TemplateKeyFields {
  paper: PaperSize | string;
  orientation: PaperOrientation | string;
  printScale: number;
  paperWidthMm?: number | null;
  paperHeightMm?: number | null;
}

/**
 * `<paper>-<orientation>-<scale>`, e.g. `A4-portrait-10000`. Custom paper
 * names its size in whole millimetres (`custom210x297-portrait-10000`), so
 * two custom sizes never share a key.
 */
export function templateAutoKey(t: TemplateKeyFields): string {
  const paper =
    t.paper === "custom"
      ? `custom${Math.round(t.paperWidthMm ?? 0)}x${Math.round(t.paperHeightMm ?? 0)}`
      : t.paper;
  return `${paper}-${t.orientation}-${Math.round(t.printScale)}`;
}

/** An auto template's name: the key in words, `A4 portrait 1:10000`. */
export function templateKeyName(t: TemplateKeyFields): string {
  const paper =
    t.paper === "custom"
      ? `${Math.round(t.paperWidthMm ?? 0)}×${Math.round(t.paperHeightMm ?? 0)} mm`
      : t.paper;
  return `${paper} ${t.orientation} 1:${Math.round(t.printScale)}`;
}

export interface AutoCandidate {
  id: string;
  /** `course_maps` rows pointing at the template. */
  sheetCount: number;
  createdAt: Date;
  /** Tie-break after `createdAt` (rows created in one statement share it). */
  seq: number;
}

/**
 * Decision (3): the auto template of one key is the candidate with the
 * most sheets, ties to the oldest (`createdAt`, then `seq`). Null for none.
 */
export function pickAutoTemplate(candidates: readonly AutoCandidate[]): string | null {
  let best: AutoCandidate | null = null;
  for (const c of candidates) {
    if (
      !best ||
      c.sheetCount > best.sheetCount ||
      (c.sheetCount === best.sheetCount &&
        (c.createdAt.getTime() < best.createdAt.getTime() ||
          (c.createdAt.getTime() === best.createdAt.getTime() && c.seq < best.seq)))
    ) {
      best = c;
    }
  }
  return best?.id ?? null;
}

/** A new template's settings: the frame inside the margin, the block top right (as the Map templates page creates one). */
export function defaultTemplateSettings(
  paper: PaperDimensions,
  marginMm = 3,
  appearance: MapAppearance = defaultMapAppearance,
): MapTemplateSettings {
  return {
    printMarginMm: marginMm,
    mapFrame: defaultMapFrame(paper, marginMm),
    description: { visible: true, x: Math.max(marginMm, paper.width - marginMm - 48), y: marginMm + 4, cellSizeMm: 6 },
    appearance,
  };
}

/** Space kept around the course inside the frame when choosing a sheet (a circle and its number, 08 §4.6). */
export const COURSE_FIT_MARGIN_MM = 6;

/**
 * 08 §4.6 "the first sheet of a course fits the course with a margin": of
 * the preferred orientation and the other one (same paper and scale), the
 * first whose frame holds the course's extent at print scale plus
 * `COURSE_FIT_MARGIN_MM` on every side; when neither does, the one that
 * comes closest. The window is centred on the course (`centerOfControls`,
 * a null window centre), so only the orientation is chosen here — paper and
 * scale stay the event's (a setter decides A3 or another scale).
 */
export function fitOrientation(
  extentMm: { width: number; height: number },
  ratio: number,
  paper: PaperSize,
  preferred: PaperOrientation,
  marginMm: number,
  custom?: PaperDimensions,
): PaperOrientation {
  const needW = extentMm.width * ratio + 2 * COURSE_FIT_MARGIN_MM;
  const needH = extentMm.height * ratio + 2 * COURSE_FIT_MARGIN_MM;
  const order: PaperOrientation[] = preferred === "portrait" ? ["portrait", "landscape"] : ["landscape", "portrait"];
  const fit = (o: PaperOrientation) => {
    const p = getPaperDimensions(paper, o, custom);
    const w = p.width - 2 * marginMm, h = p.height - 2 * marginMm;
    return Math.min(w / Math.max(needW, 1e-9), h / Math.max(needH, 1e-9));
  };
  const fits = order.find((o) => fit(o) >= 1);
  if (fits) return fits;
  return fit(order[1]) > fit(order[0]) ? order[1] : order[0];
}

/** The print scales a setter or all-controls sheet is fitted to (docs/course-layout.md §8), largest map first. */
export const STANDARD_PRINT_SCALES = [4000, 5000, 7500, 10000, 15000] as const;

/**
 * 08 §4.6 "the all-controls and setter-map sheets compute scale,
 * orientation … to fit everything on A4": of `STANDARD_PRINT_SCALES`,
 * largest map first, the first scale at which one of the two orientations
 * (the preferred first) holds `extentMm` (map mm at 1:`mapScale`) with
 * `COURSE_FIT_MARGIN_MM` on every side inside the printable area — the
 * `fitOrientation` rule at each scale. None does: 1:15 000 in the
 * orientation that comes closer.
 */
export function fitScale(
  extentMm: { width: number; height: number },
  mapScale: number,
  paper: PaperSize,
  preferred: PaperOrientation,
  marginMm: number,
  custom?: PaperDimensions,
): { orientation: PaperOrientation; printScale: number } {
  const order: PaperOrientation[] = preferred === "portrait" ? ["portrait", "landscape"] : ["landscape", "portrait"];
  const holds = (o: PaperOrientation, scale: number) => {
    const ratio = mapScale / scale;
    const p = getPaperDimensions(paper, o, custom);
    return extentMm.width * ratio + 2 * COURSE_FIT_MARGIN_MM <= p.width - 2 * marginMm + 1e-9 &&
      extentMm.height * ratio + 2 * COURSE_FIT_MARGIN_MM <= p.height - 2 * marginMm + 1e-9;
  };
  for (const printScale of STANDARD_PRINT_SCALES) {
    const orientation = order.find((o) => holds(o, printScale));
    if (orientation) return { orientation, printScale };
  }
  const last = STANDARD_PRINT_SCALES[STANDARD_PRINT_SCALES.length - 1];
  return { orientation: fitOrientation(extentMm, mapScale / last, paper, preferred, marginMm, custom), printScale: last };
}
