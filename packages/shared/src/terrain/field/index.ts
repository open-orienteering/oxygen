/**
 * The height field of a map document (docs/map-terrain.md §4–5).
 *
 * Import by subpath: `@oxygen/shared/src/terrain/field/index.js` for the
 * derivation; a client that only reads a stored field imports
 * `terrain/field/read.js`, which leaves out `build` and `interpolate` (and
 * through them `graph/` and `solve/`).
 */

export * from "./read.js";
export * from "./interpolate.js";
export * from "./build.js";
export * from "./ground.js";
