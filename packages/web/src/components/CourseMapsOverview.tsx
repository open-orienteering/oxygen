/**
 * The Courses page's print overview cells (E-pages; docs/course-maps.md "Where
 * sheets and templates are managed"): what the Maps page showed per course
 * — its template (with the key's auto / extra badge, docs/course-layout.md
 * §5), its print status, Edit layout and the course's PDF — and the one
 * template picker: the event's templates, the club library (brought into
 * the event on pick) and "New template…".
 *
 * Only a course's own sheets count (class sheets follow their class's
 * override, docs/course-layout.md §6).
 */

import { useTranslation } from "react-i18next";
import { parsePick, pickValue, type TemplatePick } from "../lib/template-picker";
import type { CourseSheetInfo } from "../hooks/useCourseMapsOverview";

/** The one picker: event templates, the club library, New template…. */
export function TemplatePicker({ value, onPick, templates, club, testId, ariaLabel, placeholder, disabled }: {
  value: string;
  onPick: (pick: TemplatePick | null, value: string) => void;
  templates: readonly { seq: number; name: string }[];
  club: readonly { id: bigint | number | string; name: string }[];
  testId: string;
  ariaLabel?: string;
  placeholder: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation("courses");
  return (
    <select data-testid={testId} aria-label={ariaLabel} value={value} disabled={disabled}
      onChange={(e) => onPick(parsePick(e.target.value), e.target.value)}
      className="max-w-[12rem] rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer">
      <option value="">{placeholder}</option>
      {templates.map((x) => <option key={x.seq} value={pickValue({ kind: "template", seq: x.seq })}>{x.name}</option>)}
      {club.length > 0 && (
        <optgroup label={t("clubLibrary")}>
          {club.map((c) => <option key={String(c.id)} value={pickValue({ kind: "club", id: String(c.id) })}>{c.name}</option>)}
        </optgroup>
      )}
      <option value={pickValue({ kind: "new" })}>{t("newTemplateOption")}</option>
    </select>
  );
}

/** The template's auto / extra badge (docs/course-layout.md §5): the key in the title. */
export function TemplateBadge({ template, testId }: { template: CourseSheetInfo["template"]; testId: string }) {
  const { t } = useTranslation("courses");
  if (!template?.autoKey) return null;
  return (
    <span data-testid={testId} data-extra={template.isExtra ? "true" : "false"} title={template.autoKey}
      className={`ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium ${template.isExtra ? "bg-amber-100 text-amber-800" : "bg-purple-100 text-purple-700"}`}>
      {template.isExtra ? t("templateExtra") : t("templateAuto")}
    </span>
  );
}

export function PrintStatusPill({ info, testId }: { info: CourseSheetInfo; testId: string }) {
  const { t } = useTranslation("courses");
  const cls = info.printStatus === "ready"
    ? "bg-emerald-100 text-emerald-700"
    : info.printStatus === "issues" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-500";
  const label = info.printStatus === "ready"
    ? t("valid")
    : info.printStatus === "issues" ? t("issuesCount", { count: info.issueCount }) : t("noMap");
  return (
    <span data-testid={testId} data-status={info.printStatus} className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}
