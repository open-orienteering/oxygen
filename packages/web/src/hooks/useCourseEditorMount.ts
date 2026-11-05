/**
 * Which course editor an event mounts (docs/map-pipeline-switch.md §3.6):
 * `vector` for the new editor (`vector ∧ pinned ∧ map.editor.vector`, with
 * WebGL2 or legacy disallowed), `legacy` otherwise, null while the answers
 * load. `/:nameId/course-editor` mounts by it; the Maps and Map templates
 * pages' *Edit layout* open the new editor's Layout mode by it
 * (docs/course-layout.md §4).
 */

import { trpc } from "../lib/trpc";
import { courseEditorMount, hasWebGL2, type MapPipeline } from "../lib/map-pipeline";

export function useCourseEditorMount(): MapPipeline | null {
  const mapInfo = trpc.course.mapFileInfo.useQuery(undefined, { staleTime: Number.POSITIVE_INFINITY });
  const mapMetadata = trpc.course.mapMetadata.useQuery(undefined, { staleTime: Number.POSITIVE_INFINITY, enabled: !!mapInfo.data });
  const hash = mapMetadata.data?.documentHash ?? null;
  // Same query and cache entry as MapPanel's.
  const mapPipeline = trpc.event.mapPipeline.useQuery(undefined, { staleTime: 30_000, enabled: !!hash });
  const answered = !mapInfo.isLoading && (!mapInfo.data || !mapMetadata.isLoading) && (!hash || !mapPipeline.isLoading);
  if (!answered) return null;
  return courseEditorMount(mapPipeline.data?.pipeline, hash, mapPipeline.data?.editorVector, {
    webgl2: hasWebGL2(),
    allowLegacy: mapPipeline.data?.allowLegacy ?? true,
  });
}

/** The new editor's Layout mode on a sheet or a template (docs/course-layout.md §4). */
export function layoutEditorHref(nameId: string, target: { sheet: number } | { template: number }, courseSeq?: number | null): string {
  const q = new URLSearchParams({ mode: "layout" });
  if ("sheet" in target) q.set("sheet", String(target.sheet));
  else q.set("template", String(target.template));
  if (courseSeq != null) q.set("course", String(courseSeq));
  return `/${encodeURIComponent(nameId)}/course-editor?${q}`;
}
