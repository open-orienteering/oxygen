/**
 * The map pipeline switch (docs/map-pipeline-switch.md).
 *
 * Two instance flags in `oxygen.settings` and one per-event column:
 *
 *   - `map.pipeline.default` — `legacy | vector`, what a new event gets.
 *   - `map.pipeline.allowLegacy` — `true | false`, whether an event may be
 *     switched (back) to `legacy`.
 *   - `events.map_pipeline` — which pipeline the event *reads* through.
 *
 * The flags are read through a 30 s memo (§1): flipping them takes effect
 * on every instance within half a minute, without a restart.
 */

import { getSetting } from "./db.js";
import { ttlMemo } from "./ttl-memo.js";

export type MapPipeline = "legacy" | "vector";

export const MAP_PIPELINES = ["legacy", "vector"] as const satisfies readonly MapPipeline[];

export const MAP_PIPELINE_SETTINGS = {
  default: "map.pipeline.default",
  allowLegacy: "map.pipeline.allowLegacy",
} as const;

export interface MapPipelineFlags {
  defaultPipeline: MapPipeline;
  allowLegacy: boolean;
}

/** Anything but `vector` (absent, empty, unknown) is `legacy`. */
export function parseDefaultPipeline(raw: string | null): MapPipeline {
  return raw?.trim().toLowerCase() === "vector" ? "vector" : "legacy";
}

/** Only an explicit `false` withdraws `legacy`; absent means allowed. */
export function parseAllowLegacy(raw: string | null): boolean {
  return raw?.trim().toLowerCase() !== "false";
}

export async function readMapPipelineFlags(
  read: (key: string) => Promise<string | null> = getSetting,
): Promise<MapPipelineFlags> {
  const [def, allow] = await Promise.all([
    read(MAP_PIPELINE_SETTINGS.default),
    read(MAP_PIPELINE_SETTINGS.allowLegacy),
  ]);
  return { defaultPipeline: parseDefaultPipeline(def), allowLegacy: parseAllowLegacy(allow) };
}

/** Whether an event may be switched to `target` under these flags. */
export function canSwitchTo(target: MapPipeline, flags: MapPipelineFlags): boolean {
  return target === "vector" || flags.allowLegacy;
}

const cached = ttlMemo(30_000, () => readMapPipelineFlags());

/** The instance flags, cached 30 s per process. */
export function getMapPipelineFlags(): Promise<MapPipelineFlags> {
  return cached.get();
}

/** Drop the cached flags (after `setSetting` on this process, and in tests). */
export function clearMapPipelineFlagsCache(): void {
  cached.clear();
}

/** The pipeline a newly created event gets: the instance default. */
export async function newEventMapPipeline(): Promise<MapPipeline> {
  return (await getMapPipelineFlags()).defaultPipeline;
}
