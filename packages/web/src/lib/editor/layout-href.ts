/** The new editor's Layout mode on a sheet or a template (docs/course-layout.md §4). */
export function layoutEditorHref(nameId: string, target: { sheet: number } | { template: number }, courseSeq?: number | null): string {
  const q = new URLSearchParams({ mode: "layout" });
  if ("sheet" in target) q.set("sheet", String(target.sheet));
  else q.set("template", String(target.template));
  if (courseSeq != null) q.set("course", String(courseSeq));
  return `/${encodeURIComponent(nameId)}/course-editor?${q}`;
}

/**
 * Where the retired Maps and Map templates pages send an old link (E-pages;
 * docs/course-maps.md "Where sheets and templates are managed"): `/maps` →
 * the Courses page (its `?course=` is the Courses page's too), `/map-templates`
 * → Layout mode, on `?template=` when it names one.
 */
export function retiredPageHref(nameId: string, page: "maps" | "map-templates", search: string): string {
  if (page === "maps") return `/${encodeURIComponent(nameId)}/courses${search}`;
  const template = Number(new URLSearchParams(search).get("template"));
  if (Number.isInteger(template) && template > 0) return layoutEditorHref(nameId, { template });
  return `/${encodeURIComponent(nameId)}/course-editor?mode=layout`;
}
