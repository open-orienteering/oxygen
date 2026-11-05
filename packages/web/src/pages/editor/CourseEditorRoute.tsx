/**
 * `/:nameId/course-editor` (docs/map-pipeline-switch.md §3.6): the new
 * editor (`EditorPage`) for `vector ∧ pinned ∧ map.editor.vector` — the
 * temporary instance flag of slice D, removed in E — and the untouched
 * legacy `CourseEditorPage` otherwise, including where the viewer itself
 * falls back to tiles (no WebGL2 while legacy is allowed). Waits for the
 * answers before mounting either, so an event never flashes the other one.
 */

import { lazy, Suspense } from "react";
import { useCourseEditorMount } from "../../hooks/useCourseEditorMount";

const EditorPage = lazy(() => import("./EditorPage").then((m) => ({ default: m.EditorPage })));
const CourseEditorPage = lazy(() => import("../CourseEditorPage").then((m) => ({ default: m.CourseEditorPage })));

export function CourseEditorRoute() {
  const mount = useCourseEditorMount();
  if (mount === null) return <div data-testid="course-editor-loading" className="p-6 text-sm text-slate-400">…</div>;
  return <Suspense fallback={null}>{mount === "vector" ? <EditorPage /> : <CourseEditorPage />}</Suspense>;
}
