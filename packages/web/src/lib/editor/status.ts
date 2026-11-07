/**
 * What the editor tells about the course and the save (docs/course-editor.md
 * §2, §3, §8): the rows of the top bar's course-info popover (`editor-stats`)
 * and the phone's peek line, and the save indicator's look. P2 took the
 * desktop status bar out of the editor's footer; this is its model.
 */

export type SaveState = "saved" | "saving" | "error" | "conflict";

export interface StatusInput {
  /** The selected course's control count; null without a course. */
  controls: number | null;
  /** The course's length, metres; null without a course. */
  lengthM: number | null;
  /** The course's stored climb (entered on the Courses page), metres; shown when set. */
  climbM: number | null;
  /** The map scale's denominator. */
  scale: number | null;
  /** The shown sheet's print scale, paper and orientation (`1:10000 A4 portrait`), in place of the map scale. */
  sheetKey: string | null;
  snapping: boolean;
  /** The number of advisory checks (§8). */
  checks: number | null;
}

export type StatusRowId = "controls" | "length" | "climb" | "scale" | "sheet" | "snapping" | "checks";

export interface StatusRow {
  id: StatusRowId;
  text: string;
  /** Machine-readable values for the row's `data-*` attributes. */
  data: Record<string, string>;
}

type T = (key: string, opts?: Record<string, unknown>) => string;

/** The rows that have a value, in the order controls · length · climb · scale | sheet · snapping · checks. */
export function statusRows(s: StatusInput, t: T): StatusRow[] {
  const rows: StatusRow[] = [];
  if (s.controls !== null) rows.push({ id: "controls", text: t("statusControls", { count: s.controls }), data: { count: String(s.controls) } });
  if (s.lengthM !== null) rows.push({ id: "length", text: t("statusLength", { km: (s.lengthM / 1000).toFixed(1) }), data: { m: String(Math.round(s.lengthM)) } });
  if (s.climbM) rows.push({ id: "climb", text: t("statusClimb", { m: Math.round(s.climbM) }), data: { m: String(Math.round(s.climbM)) } });
  if (s.sheetKey) rows.push({ id: "sheet", text: s.sheetKey, data: { key: s.sheetKey } });
  else if (s.scale) rows.push({ id: "scale", text: t("statusScale", { scale: s.scale.toLocaleString("sv-SE") }), data: { scale: String(s.scale) } });
  if (s.snapping) rows.push({ id: "snapping", text: t("statusSnapping"), data: {} });
  if (s.checks) rows.push({ id: "checks", text: t("statusChecks", { count: s.checks }), data: { count: String(s.checks) } });
  return rows;
}

/** The check count on the popover's button (§8); none at zero. */
export const checksBadge = (checks: number | null): number | null => (checks && checks > 0 ? checks : null);

export interface SaveIndicator {
  tone: "ok" | "busy" | "alert";
  /** True for a failed or conflicting save: its text shows at every width, never only in a tooltip. */
  alwaysText: boolean;
  key: "statusSaved" | "statusSaving" | "statusError" | "statusConflict";
}

export function saveIndicator(save: SaveState): SaveIndicator {
  switch (save) {
    case "saved": return { tone: "ok", alwaysText: false, key: "statusSaved" };
    case "saving": return { tone: "busy", alwaysText: false, key: "statusSaving" };
    case "error": return { tone: "alert", alwaysText: true, key: "statusError" };
    case "conflict": return { tone: "alert", alwaysText: true, key: "statusConflict" };
  }
}
