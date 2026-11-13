/**
 * Escape during a mouse drag (docs/course-editor.md §3, §10 "Loupe"; F24, user 2026-11-11): the viewer cancels the
 * drag in flight — the tool's gesture (`onPointerUp(null)`), a control's or a number's (snapped back, nothing
 * written) — and its loupe goes; the page's Escape cascade then runs as before. A touch drag is left alone.
 */
export type MouseDrag = "tool" | "control" | "number";

export function escapeCancels(d: {
  /** A gesture the active tool took on a mouse press (`toolDragRef`; touch presses have their own ref). */
  tool: boolean;
  control: { touch: boolean } | null;
  number: { touch: boolean } | null;
}): MouseDrag | null {
  if (d.tool) return "tool";
  if (d.control) return d.control.touch ? null : "control";
  if (d.number) return d.number.touch ? null : "number";
  return null;
}
