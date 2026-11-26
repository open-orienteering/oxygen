/**
 * Pure helpers for the runner inline editor (`RunnerInlineDetail`, fix
 * package 11: WEB-07, WEB-08). Kept out of the component so the node vitest
 * setup can test them without a DOM.
 */

export type RunnerEditValue = string | number | null;
export type PendingEdits = Record<string, RunnerEditValue>;

/**
 * Add one field edit to the pending map. Every field edited before the save
 * fires is kept (WEB-07: one shared timer used to send only the last field);
 * a later edit of the same field replaces the earlier one. Never mutates
 * `pending`.
 */
export function mergePendingEdits(
  pending: PendingEdits,
  field: string,
  value: RunnerEditValue,
): PendingEdits {
  return { ...pending, [field]: value };
}

export type RunnerEditError = "nameRequired" | "classRequired";

/**
 * Split pending edits into what may be sent and what the server would refuse
 * anyway (WEB-08): a blank name (`min(1)`) and class 0 ("-", NOT_FOUND). The
 * invalid keys are dropped from `data`, so the valid edits beside them still
 * save; `errors` maps each dropped field to its i18n key.
 */
export function validateRunnerEdits(pending: PendingEdits): {
  data: PendingEdits;
  errors: Record<string, RunnerEditError>;
} {
  const data: PendingEdits = {};
  const errors: Record<string, RunnerEditError> = {};
  for (const [field, value] of Object.entries(pending)) {
    if (field === "name" && (typeof value !== "string" || value.trim() === "")) {
      errors.name = "nameRequired";
    } else if (field === "classId" && (typeof value !== "number" || !(value > 0))) {
      errors.classId = "classRequired";
    } else {
      data[field] = value;
    }
  }
  return { data, errors };
}

/**
 * Whether the text in an input matches the stored value it shows. Number
 * fields compare as numbers (`parseInt(v) || 0`, the rule the editor saves
 * with), so "007" is settled against a stored 7 and "" against 0.
 */
export function isSettled(local: string, stored: string, type: "text" | "number" = "text"): boolean {
  if (type === "number") return (parseInt(local, 10) || 0) === (parseInt(stored, 10) || 0);
  return local === stored;
}

/**
 * Whether an input may take the stored value from props (WEB-07 part 2): never
 * while it has focus, and never while it holds text not yet stored, so a
 * refetch for an earlier save cannot rewrite what is being typed.
 */
export function shouldSyncField(state: { focused: boolean; dirty: boolean }): boolean {
  return !state.focused && !state.dirty;
}

/** The tRPC error text without its `CODE: ` prefix, as the editor shows it. */
export function saveErrorText(message: string): string {
  return message.replace(/^[A-Z_]+: /, "");
}
