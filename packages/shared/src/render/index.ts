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
