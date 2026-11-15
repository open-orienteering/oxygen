/**
 * Map mode's keys (docs/course-editor.md §13 "Gestures and keys"; 08 §5.3, the Map column). Undo / redo are the
 * page's, as in every mode. Course mode's tool keys (`S K M X C A T G`) are not here: course edits are locked.
 */

export type MapKeyAction =
  | { kind: "select-tool" }
  | { kind: "toggle-overprint" }
  | { kind: "fit" }
  | { kind: "step"; dir: 1 | -1 }
  | { kind: "hide" }
  | { kind: "escape" };

export interface KeyLike { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; repeat?: boolean }

/** The action a key press is in Map mode, or null (not Map mode's). */
export function mapKeyAction(e: KeyLike): MapKeyAction | null {
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === "Escape") return { kind: "escape" };
  if (e.key === "Tab" && !mod && !e.altKey) return { kind: "step", dir: e.shiftKey ? -1 : 1 };
  // A held Delete hides once: its auto-repeat is not another gesture.
  if ((e.key === "Delete" || e.key === "Backspace") && !mod && !e.altKey) return e.repeat ? null : { kind: "hide" };
  if (mod || e.altKey || e.key.length !== 1) return null;
  switch (e.key.toUpperCase()) {
    case "V": return { kind: "select-tool" };
    case "H": return { kind: "toggle-overprint" };
    case "F": return { kind: "fit" };
    default: return null;
  }
}
