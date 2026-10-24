import type { DocumentColour } from "../../map-document/header.js";
import { paletteStack } from "../../symbol-library/palette.js";
import type { SymbolLibraryId } from "../../symbol-library/index.js";
import type { CourseDocumentContext, CourseLayerInput, CourseSite, CourseStructure } from "../types.js";

/** A library palette as an aligned document stack (every row stands for its palette id). */
export function alignedStack(spec: SymbolLibraryId): DocumentColour[] {
  return paletteStack("iof2024", spec).map((c) => ({ ...c, paletteIds: [c.id.slice(c.id.indexOf(":") + 1)] }));
}

export const isomContext = (documentFactor = 1): CourseDocumentContext => ({ colours: alignedStack("ISOM2017-2"), libraryId: "ISOM2017-2", documentFactor });
export const sprintContext = (): CourseDocumentContext => ({ colours: alignedStack("ISSprOM2019-2"), libraryId: "ISSprOM2019-2", documentFactor: 1 });

export const site = (id: string, kind: CourseSite["kind"], x: number, y: number, code = id): CourseSite => ({ id, code, kind, x, y });

/** S → 31 → 32 → 33 → F along a zig-zag, paper mm. */
export const SITES: CourseSite[] = [
  site("S", "start", 10, 10, "S1"),
  site("31", "control", 40, 10),
  site("32", "control", 60, 40),
  site("33", "control", 30, 50),
  site("F", "finish", 10, 40, "F1"),
  site("99", "control", 80, 80),
];

export const linear = (ids = ["S", "31", "32", "33", "F"], extra: Partial<CourseStructure> = {}): CourseStructure => ({
  version: 1, id: "c1", orderMode: "ordered", items: ids.map((siteId) => ({ siteId })), ...extra,
});

export const layerInput = (over: Partial<CourseLayerInput> = {}): CourseLayerInput => ({
  structure: linear(),
  sites: SITES,
  objects: [],
  appearance: {},
  viewOptions: {},
  document: isomContext(),
  ...over,
});
