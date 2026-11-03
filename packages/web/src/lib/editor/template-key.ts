/**
 * The Layout inspector's template section (docs/course-layout.md §5; 08
 * §4.6): courses in this template and other courses at its key, where a
 * course moves out to, and a free name for an extra template.
 */

export interface SheetRow {
  kind: string;
  courseId: number | null;
  course: { seq: number; name: string } | null;
  class: { seq: number } | null;
  template: { seq: number; autoKey: string | null } | null;
}

export interface TemplateRow {
  seq: number;
  name: string;
  autoKey: string | null;
  isExtra: boolean;
}

export interface KeyCourse {
  seq: number;
  name: string;
  /** The template the course's own sheets use (the first sheet's). */
  templateSeq: number;
}

/**
 * Courses whose own sheets (not a class's) use `template`, and courses at
 * the same key on another template — 08 §4.6 "courses in this template /
 * other courses at this scale".
 */
export function templateCourses(sheets: readonly SheetRow[], template: TemplateRow): { inTemplate: KeyCourse[]; others: KeyCourse[] } {
  const byCourse = new Map<number, KeyCourse & { autoKey: string | null }>();
  for (const s of sheets) {
    if (s.kind !== "course" || s.class || !s.course || !s.template || byCourse.has(s.course.seq)) continue;
    byCourse.set(s.course.seq, { seq: s.course.seq, name: s.course.name, templateSeq: s.template.seq, autoKey: s.template.autoKey });
  }
  const all = [...byCourse.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const strip = ({ autoKey: _k, ...c }: KeyCourse & { autoKey: string | null }): KeyCourse => c;
  return {
    inTemplate: all.filter((c) => c.templateSeq === template.seq).map(strip),
    others: all.filter((c) => c.templateSeq !== template.seq && template.autoKey !== null && c.autoKey === template.autoKey).map(strip),
  };
}

/** Where a course moved out of `template` goes: the key's auto template, or (from the auto one) the key's first extra; null when the key has no other. */
export function moveOutTarget(templates: readonly TemplateRow[], template: TemplateRow): number | null {
  const same = templates.filter((t) => t.autoKey !== null && t.autoKey === template.autoKey && t.seq !== template.seq);
  return (same.find((t) => !t.isExtra) ?? same[0])?.seq ?? null;
}

/** `<name> (extra)`, `<name> (extra 2)`, … — template names are unique per event. */
export function extraTemplateName(name: string, taken: ReadonlySet<string>, word = "extra"): string {
  const base = `${name} (${word})`;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) if (!taken.has(`${name} (${word} ${i})`)) return `${name} (${word} ${i})`;
}
