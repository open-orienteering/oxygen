/**
 * `@oxygen/shared/course` — the course layer (docs/course-layer.md):
 * structure + sites + layout objects → objects with the library's 7xx
 * symbols on the document's colour stack, plus the GeoJSON projection.
 */

export * from "./types.js";
export { courseLayer, courseRenderInput, type CourseRenderInput } from "./layer.js";
export { courseLayerGeoJson, type CourseGeoJson, type CourseGeoJsonFeature } from "./geojson.js";
export { CUT_CODES, CUT_AIR_MM, DEFAULT_FEATURE_RADIUS_MM, circleCuts, legGaps, cutFeaturesOfDocument, cutSymbolRadiusMm, cutContextForScale, pointSymbolRadiusMm, ocadCutSymbolRadiiMm } from "./cuts.js";
export { CourseStackError, courseColourStack } from "./colour-stack.js";
export { courseDocumentContext } from "./context.js";
