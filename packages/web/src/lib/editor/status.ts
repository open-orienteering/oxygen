/**
 * What the editor tells about the course and the save (docs/course-editor.md
 * §2, §3, §8): the rows of the top bar's course-info popover (`editor-stats`)
 * and the phone's peek line, and the save indicator's look. P2 took the
 * desktop status bar out of the editor's footer; this is its model. Since P6
 * the desktop popover has no map scale (`courseInfoRows`): the scale is the
 * map-info dialog's (`lib/editor/map-info.ts`); the phone, which has no such
 * dialog, keeps it on its peek line (`statusRows`).
 */

import type { LineClimbStatus } from "./elevation";

/** `queued`: Field mode's writes wait in the device's outbox (D9c, docs/course-editor.md §9 "Offline"). */
export type SaveState = "saved" | "saving" | "error" | "conflict" | "queued";

export interface StatusInput {
  /** The selected course's control count; null without a course. */
  controls: number | null;
  /** The course's length, metres; null without a course. */
  lengthM: number | null;
  /** The course's stored climb, metres. */
  climbM: number | null;
  /** The stored climb was typed (Courses page, an import): it is the course's climb, the computed one is not shown. */
  climbManual?: boolean;
  /** The climb computed from the height field along the course (docs/course-elevation.md §4); null or absent: the stored climb only. */
  line?: LineClimbStatus | null;
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
  /** The phone's peek line shows this in place of `text`; an empty string leaves the row out there. */
  short?: string;
  /** Machine-readable values for the row's `data-*` attributes. */
  data: Record<string, string>;
}

type StatusKey = "statusControls" | "statusLength" | "statusClimb" | "statusScale" | "statusSnapping" | "statusChecks"
  | "statusClimbShare" | "statusClimbLoading" | "statusClimbUnavailable";
/** The editor namespace's `t`, narrowed to the keys the rows use. */
type T = (key: StatusKey, opts?: { count?: number; km?: string; m?: number | string; scale?: string; share?: string }) => string;

/**
 * The climb row (docs/course-elevation.md §4.4): one number. A typed climb (`climbManual`) is the course's; else the
 * climb computed from the height field, with its share of the length; else the stored climb while the field loads
 * or cannot be read; else what the field's state is.
 */
function climbRow(s: StatusInput, t: T): StatusRow | null {
  const stored = s.climbM ? Math.round(s.climbM) : null;
  const line = s.line ?? null;
  if (stored !== null && (s.climbManual || !line))
    return { id: "climb", text: t("statusClimb", { m: stored }), data: { m: String(stored), source: s.climbManual ? "manual" : "stored" } };
  if (!line) return null;
  if (line.state === "ready") {
    const m = `${line.approx ? "≈ " : ""}${line.climbM}`;
    const share = line.sharePct === null ? "" : line.sharePct.toFixed(1);
    return {
      id: "climb", text: share ? t("statusClimbShare", { m, share }) : t("statusClimb", { m }), short: t("statusClimb", { m }),
      data: { m: String(line.climbM), source: "computed", state: "ready", share, basis: line.basis, partial: String(line.partial), approx: String(line.approx) },
    };
  }
  const data: Record<string, string> = line.state === "loading" ? { state: "loading" } : { state: "unavailable", kind: line.kind };
  if (stored !== null) return { id: "climb", text: t("statusClimb", { m: stored }), data: { m: String(stored), source: "stored", ...data } };
  return { id: "climb", text: t(line.state === "loading" ? "statusClimbLoading" : "statusClimbUnavailable"), short: "", data };
}

/** The rows that have a value, in the order controls · length · climb · scale | sheet · snapping · checks. */
export function statusRows(s: StatusInput, t: T): StatusRow[] {
  const rows: StatusRow[] = [];
  if (s.controls !== null) rows.push({ id: "controls", text: t("statusControls", { count: s.controls }), data: { count: String(s.controls) } });
  if (s.lengthM !== null) rows.push({ id: "length", text: t("statusLength", { km: (s.lengthM / 1000).toFixed(1) }), data: { m: String(Math.round(s.lengthM)) } });
  const climb = climbRow(s, t);
  if (climb) rows.push(climb);
  if (s.sheetKey) rows.push({ id: "sheet", text: s.sheetKey, data: { key: s.sheetKey } });
  else if (s.scale) rows.push({ id: "scale", text: t("statusScale", { scale: s.scale.toLocaleString("sv-SE") }), data: { scale: String(s.scale) } });
  if (s.snapping) rows.push({ id: "snapping", text: t("statusSnapping"), data: {} });
  if (s.checks) rows.push({ id: "checks", text: t("statusChecks", { count: s.checks }), data: { count: String(s.checks) } });
  return rows;
}

/** The desktop course-info popover's rows (§2): `statusRows` without the map scale, which is the map-info dialog's (P6). */
export function courseInfoRows(s: Omit<StatusInput, "scale">, t: T): StatusRow[] {
  return statusRows({ ...s, scale: null }, t);
}

/** The check count on the popover's button (§8); none at zero. */
export const checksBadge = (checks: number | null): number | null => (checks && checks > 0 ? checks : null);

export interface SaveIndicator {
  tone: "ok" | "busy" | "alert" | "wait";
  /** True for a failed, conflicting or queued save: its words show, never only in a tooltip; otherwise the dot alone. */
  alwaysText: boolean;
  key: "statusSaved" | "statusSaving" | "statusError" | "statusConflict" | "statusQueued";
}

export function saveIndicator(save: SaveState): SaveIndicator {
  switch (save) {
    case "saved": return { tone: "ok", alwaysText: false, key: "statusSaved" };
    case "saving": return { tone: "busy", alwaysText: false, key: "statusSaving" };
    case "error": return { tone: "alert", alwaysText: true, key: "statusError" };
    case "conflict": return { tone: "alert", alwaysText: true, key: "statusConflict" };
    case "queued": return { tone: "wait", alwaysText: true, key: "statusQueued" };
  }
}
