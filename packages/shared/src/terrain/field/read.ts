/**
 * The read side of the height field (docs/map-terrain.md §5.2–5.4): the
 * types, the codec, the sampler and the normals — what a client that
 * draws or samples a stored field needs, without the derivation
 * (`build.ts`, `interpolate.ts` and through them `graph/` and `solve/`).
 *
 * Import by subpath: `@oxygen/shared/src/terrain/field/read.js`. The web
 * imports this entry, never `index.js`, so its bundle carries no derive
 * code (docs/map-rendering.md §5.6).
 */

export * from "./types.js";
export * from "./codec.js";
export * from "./sample.js";
export * from "./normals.js";
