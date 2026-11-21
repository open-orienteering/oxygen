/**
 * Heights along a course (docs/course-elevation.md §1–3). Import by
 * subpath: `@oxygen/shared/src/terrain/profile/index.js`. Reads the field
 * through its client entry only, so a web bundle carries no derive code.
 */

export * from "./types.js";
export * from "./sampler.js";
export * from "./climb.js";
export * from "./profile.js";
export * from "./pick.js";
