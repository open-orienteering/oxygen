/**
 * Automatic course-overprint cuts — the legacy feature source.
 *
 * Course setters cut the purple overprint where it would hide a compact
 * knoll or rock point feature. The rule lives in the course layer
 * (`@oxygen/shared` `course.circleCuts` / `course.legGaps`,
 * docs/course-layer.md §3.4); this module turns the base map's parsed OCAD
 * objects (`event-map-objects.ts`) into its feature list for events that
 * do not read the pinned map document (`legacy`, or no pin yet).
 *
 * `SlimMapObject` coordinates are OCAD 1/100 mm paper units; features are
 * paper mm with the radius of the symbol the file draws
 * (`course.ocadCutSymbolRadiiMm`), else of their code in the library chosen
 * by the map scale × that library's document factor.
 */

import { course } from "@oxygen/shared";
import type { SlimMapObject } from "./event-map-objects.js";

/** OCAD units per paper mm (SlimMapObject coordinates). */
const UNITS_PER_MM = 100;

/** `204000` → `"204"`, `203001` → `"203.1"` (OCAD stores sub-codes in the last three digits). */
function ocadCode(sym: number): string {
  const main = Math.floor(sym / 1000);
  const sub = sym % 1000;
  return sub ? `${main}.${sub}` : String(main);
}

/**
 * Cut features of the OCAD point objects whose code is in `CUT_CODES`
 * (`docs/course-editor.md` "Automatic overprint cuts"). `fileRadii` are
 * the file's own symbol sizes by `sym`; a symbol without one is measured
 * in the library `mapScale` picks (03 §6.5; null = the reference scale).
 */
export function cutFeaturesOfSlimObjects(
  objects: SlimMapObject[],
  fileRadii: ReadonlyMap<number, number>,
  mapScale: number | null,
): course.CutFeature[] {
  const { libraryId, documentFactor } = course.cutContextForScale(mapScale && mapScale > 0 ? mapScale : 15000);
  const radius = new Map<number, number>();
  const out: course.CutFeature[] = [];
  for (const obj of objects) {
    if (obj.objType !== 1 || !course.CUT_CODES.has(Math.floor(obj.sym / 1000))) continue;
    const p = obj.coordinates[0];
    if (!p) continue;
    let r = radius.get(obj.sym);
    if (r === undefined) {
      r = fileRadii.get(obj.sym) ?? course.cutSymbolRadiusMm(libraryId, ocadCode(obj.sym)) * documentFactor;
      radius.set(obj.sym, r);
    }
    out.push({ x: p[0] / UNITS_PER_MM, y: p[1] / UNITS_PER_MM, r });
  }
  return out;
}
