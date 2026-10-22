/**
 * The per-event map pipeline switch on the client
 * (docs/map-pipeline-switch.md §3). The event's `map_pipeline` comes from
 * `event.mapPipeline`; this module only turns it into the pipeline a map
 * actually draws with.
 */
export type MapPipeline = "legacy" | "vector";

/** `vector` needs a pinned document, so a map without one stays on tiles. */
export function resolveMapPipeline(eventPipeline: MapPipeline, documentHash: string | null | undefined): MapPipeline {
  return eventPipeline === "vector" && documentHash ? "vector" : "legacy";
}
