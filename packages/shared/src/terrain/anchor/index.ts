/**
 * The DEM anchor (docs/map-terrain.md §6).
 *
 * Import by subpath: `@oxygen/shared/src/terrain/anchor/index.js`.
 */

export * from "./types.js";
export { anchorLevels, weightedQuantile } from "./anchor.js";
export { anchoredHeights } from "./resolve.js";
export { chainDemStats, quantile, smoothedSampler, stencilSize, type SideRule } from "./sample.js";
export { circularDev, circularDist, concentration, mod } from "./interval.js";
export { candidateLadders, ladderVote, type LadderVote, type VoteArea, type VoteChain, type VoteInput } from "./ladder.js";
