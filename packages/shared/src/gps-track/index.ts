/** `@oxygen/shared` `gpsTrack` — GPX parsing, track geometry and averaging, pure (docs/map-gps-tracks.md §2–4). */
export * from "./track.js";
export * from "./gpx.js";
export * from "./project.js";
export * from "./geometry.js";
export { averageTracks, DEFAULT_ITERATIONS, DEFAULT_MATCH_DISTANCE_M, type AverageOptions, type AverageResult } from "./average.js";
