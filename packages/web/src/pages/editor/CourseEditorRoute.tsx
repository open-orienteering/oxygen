/**
 * `/:nameId/course-editor` (docs/course-editor.md §1): the course editor,
 * `EditorPage`, for every event since E3. An event without a map mounts it
 * too; its map panel shows the upload prompt, and a map whose document is
 * still being prepared shows the import state.
 */

import { lazy, Suspense } from "react";
import { useParams } from "react-router-dom";

const EditorPage = lazy(() => import("./EditorPage").then((m) => ({ default: m.EditorPage })));

export function CourseEditorRoute() {
  // Keyed on the event (MC-17, CRS-015): another event is a new editor — its own undo stack, write queues and client
  // pinned to that event — so nothing made in one event is sent, or undone, in another.
  const { nameId } = useParams<{ nameId: string }>();
  return (
    <Suspense fallback={<div data-testid="course-editor-loading" className="p-6 text-sm text-slate-400">…</div>}>
      <EditorPage key={nameId ?? ""} />
    </Suspense>
  );
}
