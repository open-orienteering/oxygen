import type { MapDocumentHeader } from "../map-document/header.js";
import { chooseLibrary } from "../import/matcher.js";
import { getSymbolLibrary, isSymbolLibraryId } from "../symbol-library/index.js";
import type { CourseDocumentContext } from "./types.js";

/**
 * The course layer's document context from a header (course-layer.md §1):
 * the library the matches refer to and the document factor; an unmatched
 * document gets the library by scale (03 §6.5) and the factor
 * reference scale / map scale.
 */
export function courseDocumentContext(header: Pick<MapDocumentHeader, "library" | "documentFactor" | "mapScale"> & { colours: CourseDocumentContext["colours"] }): CourseDocumentContext {
  if (header.library && isSymbolLibraryId(header.library.id)) {
    return { colours: header.colours, libraryId: header.library.id, documentFactor: header.documentFactor };
  }
  const libraryId = chooseLibrary(header.mapScale);
  return { colours: header.colours, libraryId, documentFactor: getSymbolLibrary(libraryId).referenceScale / header.mapScale };
}
