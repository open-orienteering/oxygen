import type { MapDocumentHeader } from "../map-document/header.js";
import { chooseLibrary, isDocumentLibraryId } from "../import/matcher.js";
import { getSymbolLibrary } from "../symbol-library/index.js";
import type { CourseDocumentContext } from "./types.js";

/**
 * The course layer's document context from a header (course-layer.md §1):
 * the library the matches refer to, the document factor and the map
 * scale (corridor widths, §10.2); an unmatched
 * document gets the library by scale (03 §6.5) and the factor
 * reference scale / map scale.
 */
export function courseDocumentContext(header: Pick<MapDocumentHeader, "library" | "documentFactor" | "mapScale"> & { colours: CourseDocumentContext["colours"] }): CourseDocumentContext {
  if (header.library && isDocumentLibraryId(header.library.id)) {
    return { colours: header.colours, libraryId: header.library.id, documentFactor: header.documentFactor, mapScale: header.mapScale };
  }
  const libraryId = chooseLibrary(header.mapScale);
  return { colours: header.colours, libraryId, documentFactor: getSymbolLibrary(libraryId).referenceScale / header.mapScale, mapScale: header.mapScale };
}
