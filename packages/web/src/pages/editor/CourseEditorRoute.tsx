/**
 * `/:nameId/course-editor` (docs/map-pipeline-switch.md §3.6): the new
 * editor (`EditorPage`) for `vector ∧ pinned ∧ map.editor.vector` — the
 * temporary instance flag of slice D, removed in E — and the untouched
 * legacy `CourseEditorPage` otherwise, including where the viewer itself
 * falls back to tiles (no WebGL2 while legacy is allowed). Waits for the
 * answers before mounting either, so an event never flashes the other one.
 */

import { lazy, Suspense } from "react";
import { trpc } from "../../lib/trpc";
import { courseEditorMount, hasWebGL2 } from "../../lib/map-pipeline";

const EditorPage = lazy(() => import("./EditorPage").then((m) => ({ default: m.EditorPage })));
const CourseEditorPage = lazy(() => import("../CourseEditorPage").then((m) => ({ default: m.CourseEditorPage })));

export function CourseEditorRoute() {
  const mapInfo = trpc.course.mapFileInfo.useQuery(undefined, { staleTime: Number.POSITIVE_INFINITY });
  const mapMetadata = trpc.course.mapMetadata.useQuery(undefined, { staleTime: Number.POSITIVE_INFINITY, enabled: !!mapInfo.data });
  const hash = mapMetadata.data?.documentHash ?? null;
  // Same query and cache entry as MapPanel's.
  const mapPipeline = trpc.event.mapPipeline.useQuery(undefined, { staleTime: 30_000, enabled: !!hash });
  const answered = !mapInfo.isLoading && (!mapInfo.data || !mapMetadata.isLoading) && (!hash || !mapPipeline.isLoading);
  if (!answered) return <div data-testid="course-editor-loading" className="p-6 text-sm text-slate-400">…</div>;
  const mount = courseEditorMount(mapPipeline.data?.pipeline, hash, mapPipeline.data?.editorVector, {
    webgl2: hasWebGL2(),
    allowLegacy: mapPipeline.data?.allowLegacy ?? true,
  });
  return <Suspense fallback={null}>{mount === "vector" ? <EditorPage /> : <CourseEditorPage />}</Suspense>;
}
