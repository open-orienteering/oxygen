/**
 * The per-event map pipeline switch on the client
 * (docs/map-pipeline-switch.md §3). The event's `map_pipeline` comes from
 * `event.mapPipeline`; this module turns it into the pipeline a map
 * actually draws with.
 */
export type MapPipeline = "legacy" | "vector";

export interface MapPipelineContext {
  /** The browser can draw WebGL2 (probe, and no lost context since). */
  webgl2: boolean;
  /** `map.pipeline.allowLegacy`: tiles are still a sanctioned fallback. */
  allowLegacy: boolean;
}

/**
 * `vector` needs a pinned document, so a map without one stays on tiles;
 * a browser that cannot draw WebGL2 falls back to tiles while legacy is
 * allowed (and shows the layer's message once it is not). An unknown
 * event value (query not answered) is `legacy`.
 */
export function resolveMapPipeline(
  eventPipeline: MapPipeline | undefined,
  documentHash: string | null | undefined,
  context: MapPipelineContext = { webgl2: true, allowLegacy: true },
): MapPipeline {
  if (eventPipeline !== "vector" || !documentHash) return "legacy";
  if (!context.webgl2 && context.allowLegacy) return "legacy";
  return "vector";
}

/**
 * Which course editor `/:nameId/course-editor` mounts (§3.6): the new one
 * on the GL canvas for `vector ∧ pinned ∧ map.editor.vector`, the legacy
 * `CourseEditorPage` otherwise — including where the viewer itself falls
 * back to tiles. The flag is temporary (slice D) and removed in E.
 */
export function courseEditorMount(
  eventPipeline: MapPipeline | undefined,
  documentHash: string | null | undefined,
  editorVector: boolean | undefined,
  context: MapPipelineContext = { webgl2: true, allowLegacy: true },
): MapPipeline {
  if (editorVector !== true) return "legacy";
  return resolveMapPipeline(eventPipeline, documentHash, context);
}

let webgl2Probe: boolean | null = null;

/** Whether this browser can create a WebGL2 context; probed once per page. */
export function hasWebGL2(): boolean {
  if (webgl2Probe !== null) return webgl2Probe;
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    webgl2Probe = !!gl;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webgl2Probe = false;
  }
  return webgl2Probe;
}
