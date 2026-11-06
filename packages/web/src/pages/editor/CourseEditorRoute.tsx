/**
 * `/:nameId/course-editor` (docs/course-editor.md §1): the course editor,
 * `EditorPage`, for every event since E3. An event without a map mounts it
 * too; its map panel shows the upload prompt, and a map whose document is
 * still being prepared shows the import state.
 */

import { lazy, Suspense } from "react";

const EditorPage = lazy(() => import("./EditorPage").then((m) => ({ default: m.EditorPage })));

export function CourseEditorRoute() {
  return (
    <Suspense fallback={<div data-testid="course-editor-loading" className="p-6 text-sm text-slate-400">…</div>}>
      <EditorPage />
    </Suspense>
  );
}
