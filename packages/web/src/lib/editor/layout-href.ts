/** The new editor's Layout mode on a sheet or a template (docs/course-layout.md §4). */
export function layoutEditorHref(nameId: string, target: { sheet: number } | { template: number }, courseSeq?: number | null): string {
  const q = new URLSearchParams({ mode: "layout" });
  if ("sheet" in target) q.set("sheet", String(target.sheet));
  else q.set("template", String(target.template));
  if (courseSeq != null) q.set("course", String(courseSeq));
  return `/${encodeURIComponent(nameId)}/course-editor?${q}`;
}
