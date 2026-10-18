/**
 * `@oxygen/shared/render` — the shared rendering contract.
 *
 * Today: the pass-stream types, geometry helpers, JSON/snapshot projection
 * and the reference SVG serialiser (spike S1 step 1, harness). The
 * symbolisation stage that produces streams from map documents lands in
 * S1 step 2 / slice B.
 */

export * from "./pass-stream.js";
export * from "./path.js";
export * from "./stream-json.js";
export * from "./reference-svg.js";
export { renderFixtures, fixtureColours, type RenderFixtureName } from "./__fixtures__/streams/index.js";
export { pilotSymbols, pilotColours, PILOT } from "./__fixtures__/pilot-symbols.js";
export * from "./ocad-objects.js";
export { pilotScene } from "./__fixtures__/pilot-scene.js";
export { goldenScene, goldenSceneNames, goldenFrame, GOLDEN_PX_PER_MM, GOLDEN_MARGIN_UM } from "./__fixtures__/golden.js";
export type { GoldenSceneName, GoldenScene, GoldenFrame } from "./__fixtures__/golden.js";
export * from "./symbol.js";
export * from "./transform.js";
export * from "./measure.js";
export * from "./dash.js";
export * from "./geometry.js";
export * from "./glyph-table.js";
export * from "./placement.js";
export * from "./pattern.js";
export * from "./text.js";
export * from "./truetype.js";
export * from "./symbolise.js";
