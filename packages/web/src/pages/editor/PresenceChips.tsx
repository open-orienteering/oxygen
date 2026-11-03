/**
 * Who else has a course open, in the top bar (docs/course-editor.md §11):
 * "Anna · Lång · Field" per editor, those on the open course highlighted.
 * `compact` (the phone's bar) shows the count, the entries in its tooltip.
 */

import { useTranslation } from "react-i18next";
import { presenceEntries, type PresenceMode, type PresenceOther } from "../../lib/editor/presence";

export function PresenceChips({ others, selectedCourseId, compact = false }: { others: PresenceOther[]; selectedCourseId: number | null; compact?: boolean }) {
  const { t } = useTranslation("editor");
  const modeLabel = (m: PresenceMode) => t(m === "course" ? "modeCourse" : m === "layout" ? "modeLayout" : "modeField");
  const entries = presenceEntries(others, selectedCourseId, modeLabel, t("presenceAnonymous"));
  if (entries.length === 0) return null;
  if (compact) {
    return (
      <span data-testid="editor-presence" title={entries.map((e) => e.label).join("\n")} aria-label={t("presenceLabel")}
        className="shrink-0 min-h-9 px-2 flex items-center rounded-md bg-sky-50 text-sky-800 text-xs">
        {entries.length}
      </span>
    );
  }
  return (
    <ul data-testid="editor-presence" aria-label={t("presenceLabel")} className="flex items-center gap-1 min-w-0 flex-wrap">
      {entries.map((e) => (
        <li key={e.key} data-testid="editor-presence-entry" data-here={e.here ? "true" : "false"}
          className={`px-2 py-0.5 rounded-full text-xs whitespace-nowrap ${e.here ? "bg-sky-100 text-sky-800 font-medium" : "bg-slate-100 text-slate-600"}`}>
          {e.label}
        </li>
      ))}
    </ul>
  );
}
