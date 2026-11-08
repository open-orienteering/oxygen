/**
 * `@oxygen/shared/course` — the course layer (docs/course-layer.md):
 * structure + sites + layout objects → objects with the library's 7xx
 * symbols on the document's colour stack, plus the GeoJSON projection.
 */

export * from "./types.js";
export { courseLayer, courseRenderInput, type CourseRenderInput } from "./layer.js";
export { legLengthMm, routedBends } from "./derive.js";
export { corridorGeometry, type CorridorEdge, type CorridorGeometry } from "./corridor.js";
export { CUT_CODES, CUT_AIR_MM, DEFAULT_FEATURE_RADIUS_MM, circleCuts, legGaps, polylineLegGaps, cutFeaturesOfDocument, cutSymbolRadiusMm, cutContextForScale, pointSymbolRadiusMm, ocadCutSymbolRadiiMm } from "./cuts.js";
export { CourseStackError, courseColourStack } from "./colour-stack.js";
export { courseDocumentContext } from "./context.js";
export { courseSymbols, type CourseSymbolSet } from "./symbols.js";
export { RING_BLEED_UM, mapLayerWindow, pageLayer, pageStreamInMap, type PageLayer, type PageLayerInput } from "./page-layer.js";
export {
  courseStructureSchema,
  courseStructureSchemaOf,
  courseStructureWireSchema,
  courseItemSchema,
  controlItemSchema,
  variationItemSchema,
  legPropsSchema,
  legPropsSchemaOf,
  NON_ITEM_SITE_KINDS,
  hasVariations,
  linearStructure,
  structureControlIds,
  structureControlItems,
  structureDiff,
  structureSiteIssues,
  type LegProps,
  type WireLegProps,
  wireLegPropsSchema,
  type StoredControlItem,
  type StoredCourseItem,
  type StoredCourseStructure,
  type StoredVariationItem,
  type StructureSiteIssue,
  type WireCourseStructure,
} from "./structure.js";
export {
  MAX_VARIANTS,
  materialiseVariants,
  pruneSiteFromStructure,
  structureSiteIds,
  variantCount,
  variantKeyDuplicates,
  variantStructure,
  type MaterialisedVariant,
} from "./variants.js";
export {
  COURSE_OBJECT_KINDS,
  courseObjectBodySchema,
  courseObjectScopeSchemaOf,
  courseObjectInScope,
  courseObjectRefId,
  filterRegionOf,
  isCourseObject,
  type CourseLayerObject,
  type CourseObject,
  type CourseObjectBody,
  type CourseObjectKind,
  type CourseObjectScope,
} from "./objects.js";
export {
  COURSE_CHECK_CODES,
  CONTROL_MIN_DISTANCE_M,
  SPRINT_CONTROL_MIN_DISTANCE_M,
  SAME_FEATURE_MIN_DISTANCE_M,
  UNCROSSABLE_CODES,
  OOB_CODES,
  courseChecks,
  checkObstaclesOfDocument,
  invertedCode,
  type CourseCheck,
  type CourseCheckCode,
  type CourseChecksInput,
  type CheckSite,
  type CheckObstacle,
  type CheckDocument,
} from "./checks.js";
