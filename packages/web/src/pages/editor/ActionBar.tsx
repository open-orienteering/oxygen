/**
 * The contextual action bar's entries (docs/course-editor.md §2, §4): what
 * the selection or the phantom offers, the legacy popover's entries and
 * `editor-action-<id>` ids, laid out horizontally under the selection by
 * the viewer (`actionLayout: "bar"`). The same list is what the mobile
 * bottom bar (D9) docks. Pure: the page passes labels and handlers.
 */

import type { EditorContextAction } from "../../components/MapViewer";

export interface ActionContext {
  /** Phantom from an empty-map or leg click (`insertAt` set for a leg). */
  phantom: { insertAt: number | null } | null;
  /** The selected site, when no phantom. */
  selected: {
    id: number;
    role: "start" | "finish" | "control";
    /** On the selected course's control sequence. */
    onCourse: boolean;
    /** Not the course's effective start / finish (start / finish sites only). */
    otherRole: boolean;
    hasLabelOffset: boolean;
    radioOn: boolean;
    /** A pending SRR swap offer for this control. */
    swapOffer: boolean;
  } | null;
  /** The selected course's name, or null. */
  course: string | null;
  /** The code universe is loaded (the next free code can be chosen). */
  codesReady: boolean;
  /** A write is in flight (delete waits for it). */
  busy: boolean;
}

export interface ActionHandlers {
  insert(): void;
  addToCourse(): void;
  add(): void;
  addStart(): void;
  addFinish(): void;
  useAsRole(role: "start" | "finish"): void;
  append(): void;
  removeFromCourse(): void;
  resetLabel(): void;
  radio(): void;
  confirmSwap(): void;
  declineSwap(): void;
  description(): void;
  delete(): void;
}

export type ActionLabel = (key: string, opts?: Record<string, string>) => string;

export function courseActions(ctx: ActionContext, on: ActionHandlers, label: ActionLabel): EditorContextAction[] {
  const out: EditorContextAction[] = [];
  if (ctx.phantom) {
    if (ctx.phantom.insertAt !== null && ctx.course) {
      out.push({ id: "insert", label: label("editor.actionInsert"), onClick: on.insert, disabled: !ctx.codesReady });
      return out;
    }
    if (ctx.course) out.push({ id: "add-to-course", label: label("editor.actionAddToCourse", { name: ctx.course }), onClick: on.addToCourse, disabled: !ctx.codesReady });
    out.push({ id: "add", label: label("editor.actionAdd"), onClick: on.add, disabled: !ctx.codesReady });
    out.push({ id: "add-start", label: label("editor.actionAddStart"), onClick: on.addStart });
    out.push({ id: "add-finish", label: label("editor.actionAddFinish"), onClick: on.addFinish });
    return out;
  }
  const s = ctx.selected;
  if (!s) return out;
  const startFinish = s.role !== "control";
  if (ctx.course && startFinish && s.otherRole) {
    const role = s.role as "start" | "finish";
    out.push({
      id: `use-as-${role}`,
      label: label(role === "start" ? "editor.actionUseAsStart" : "editor.actionUseAsFinish", { name: ctx.course }),
      onClick: () => on.useAsRole(role),
    });
  }
  if (ctx.course && !startFinish) {
    out.push({ id: "append", label: label("editor.actionAppend", { name: ctx.course }), onClick: on.append });
    if (s.onCourse) {
      out.push({ id: "remove-from-course", label: label("editor.actionRemoveFromCourse", { name: ctx.course }), onClick: on.removeFromCourse });
      if (s.hasLabelOffset) out.push({ id: "reset-label", label: label("editor.actionResetLabel"), onClick: on.resetLabel });
    }
  }
  if (!startFinish) {
    if (s.swapOffer) {
      out.push({ id: "radio-swap-confirm", label: label("yes"), onClick: on.confirmSwap });
      out.push({ id: "radio-swap-decline", label: label("no"), onClick: on.declineSwap });
    } else {
      out.push({ id: "radio", label: label(s.radioOn ? "actionRadioOff" : "actionMakeRadio"), onClick: on.radio });
    }
  }
  out.push({ id: "description", label: label("editor.actionDescription"), onClick: on.description });
  out.push({ id: "delete", label: label("editor.deleteControl"), variant: "danger", onClick: on.delete, disabled: ctx.busy });
  return out;
}
