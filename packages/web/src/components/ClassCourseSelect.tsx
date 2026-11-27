import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { SearchableSelect, type SelectOption } from "./SearchableSelect";

/** The picker of a class's one course (WEB-09): course seq or null for none. */
export function ClassCourseSelect({ value, onChange, testId }: { value: number | null; onChange: (courseId: number | null) => void; testId: string }) {
  const { t } = useTranslation("classes");
  const courses = trpc.course.list.useQuery();
  const options = useMemo<SelectOption[]>(
    () => [
      { value: 0, label: t("noCourse") },
      ...(courses.data ?? []).map((c) => ({
        value: c.id,
        label: c.name,
        suffix: `${t("controlsCount", { count: c.controlCount })}${c.length > 0 ? ` · ${(c.length / 1000).toFixed(1)} km` : ""}`,
      })),
    ],
    [courses.data, t],
  );
  return (
    <SearchableSelect
      value={value ?? 0}
      onChange={(v) => onChange(Number(v) || null)}
      options={options}
      placeholder={t("selectCourse")}
      searchPlaceholder={t("searchCourse")}
      testId={testId}
    />
  );
}
