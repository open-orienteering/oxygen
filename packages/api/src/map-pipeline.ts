/**
 * The map pipeline switch (docs/map-pipeline-switch.md).
 *
 * Three instance flags in `oxygen.settings` and one per-event column:
 *
 *   - `map.pipeline.default` — `legacy | vector`, what a new event gets.
 *   - `map.pipeline.allowLegacy` — `true | false`, whether an event may be
 *     switched (back) to `legacy`.
 *   - `map.editor.vector` — `true | false`, whether a `vector` event with a
 *     pinned document mounts the new course editor (temporary, slice D;
 *     removed in E — docs/map-pipeline-switch.md §1, §3.6).
 *   - `events.map_pipeline` — which pipeline the event *reads* through.
 *
 * The flags are read through a 30 s memo (§1): flipping them takes effect
 * on every instance within half a minute, without a restart.
 * `MAP_PIPELINE_FLAGS_TTL_MS` overrides the 30 s (`0` = every read; E2E).
 */

import { getSetting } from "./db.js";
import { ttlMemo } from "./ttl-memo.js";

export type MapPipeline = "legacy" | "vector";

export const MAP_PIPELINES = ["legacy", "vector"] as const satisfies readonly MapPipeline[];

export const MAP_PIPELINE_SETTINGS = {
  default: "map.pipeline.default",
  allowLegacy: "map.pipeline.allowLegacy",
  editorVector: "map.editor.vector",
} as const;

export interface MapPipelineFlags {
  defaultPipeline: MapPipeline;
  allowLegacy: boolean;
  /** The new course editor may mount (`vector ∧ pinned ∧ editorVector`). */
  editorVector: boolean;
}

/** Anything but `vector` (absent, empty, unknown) is `legacy`. */
export function parseDefaultPipeline(raw: string | null): MapPipeline {
  return raw?.trim().toLowerCase() === "vector" ? "vector" : "legacy";
}

/** Only an explicit `false` withdraws `legacy`; absent means allowed. */
export function parseAllowLegacy(raw: string | null): boolean {
  return raw?.trim().toLowerCase() !== "false";
}

/** Only an explicit `true` opens the new editor; absent means the legacy one. */
export function parseEditorVector(raw: string | null): boolean {
  return raw?.trim().toLowerCase() === "true";
}

export async function readMapPipelineFlags(
  read: (key: string) => Promise<string | null> = getSetting,
): Promise<MapPipelineFlags> {
  const [def, allow, editor] = await Promise.all([
    read(MAP_PIPELINE_SETTINGS.default),
    read(MAP_PIPELINE_SETTINGS.allowLegacy),
    read(MAP_PIPELINE_SETTINGS.editorVector),
  ]);
  return {
    defaultPipeline: parseDefaultPipeline(def),
    allowLegacy: parseAllowLegacy(allow),
    editorVector: parseEditorVector(editor),
  };
}

/** Whether an event may be switched to `target` under these flags. */
export function canSwitchTo(target: MapPipeline, flags: MapPipelineFlags): boolean {
  return target === "vector" || flags.allowLegacy;
}

/** The memo's lifetime: 30 s, or `MAP_PIPELINE_FLAGS_TTL_MS` when it is a non-negative number. */
export function flagsTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MAP_PIPELINE_FLAGS_TTL_MS;
  const ms = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : 30_000;
}

const cached = ttlMemo(flagsTtlMs(), () => readMapPipelineFlags());

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
