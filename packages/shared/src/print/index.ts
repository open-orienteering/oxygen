/**
 * `@oxygen/shared/print` — the PDF backend of the shared stage
 * (docs/map-rendering.md §5.3, docs/course-print.md §1–3). Isomorphic:
 * no Node API, so the same code can run in a Web Worker later (05 §5.11).
 *
 * Not exported from the package root: the PDF library stays out of the
 * web bundle and the root barrel; import it from `src/print/index.ts`
 * (the page composer, slice C2, wires the subpath).
 */

export * from "./colour.js";
export * from "./fonts.js";
export * from "./operators.js";
export * from "./writer.js";
