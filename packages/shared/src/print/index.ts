/**
 * `@oxygen/shared/print` — the PDF backend of the shared stage
 * (docs/map-rendering.md §5.3, docs/course-print.md §1–3). Isomorphic:
 * no Node API, so the same code can run in a Web Worker later (05 §5.11).
 *
 * Not exported from the package root: the PDF library stays out of the
 * web bundle and the root barrel; import it as `@oxygen/shared/print`
 * (the package's `exports` subpath, docs/course-print.md §1).
 */

export * from "./colour.js";
export * from "./fonts.js";
export * from "./operators.js";
export * from "./writer.js";
export * from "./page.js";
export * from "./description.js";
export * from "./geo.js";
export * from "./compose.js";
export { pageScene, pageSceneNames, type PageSceneName } from "./__fixtures__/pages.js";
