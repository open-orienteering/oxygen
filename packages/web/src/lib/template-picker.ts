/**
 * The Courses page's template picker (E-pages; docs/course-maps.md "Where
 * sheets and templates are managed"): one `<select>` holding the event's
 * templates, the club library's (brought in on pick) and "New template…".
 * Its option values carry the pick; `parsePick` reads one back.
 */

export type TemplatePick =
  | { kind: "template"; seq: number }
  | { kind: "club"; id: string }
  | { kind: "new" };

const CLUB = "club:";

export function pickValue(p: TemplatePick): string {
  if (p.kind === "template") return String(p.seq);
  if (p.kind === "club") return `${CLUB}${p.id}`;
  return "new";
}

export function parsePick(value: string): TemplatePick | null {
  if (value === "new") return { kind: "new" };
  if (value.startsWith(CLUB)) {
    const id = value.slice(CLUB.length);
    return /^\d+$/.test(id) ? { kind: "club", id } : null;
  }
  return /^[1-9]\d*$/.test(value) ? { kind: "template", seq: Number(value) } : null;
}

/** A free event template name: `base`, `base (2)`, … (names are unique per event; the server's `freeTemplateName`). */
export function freeTemplateName(base: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  for (let i = 2; ; i += 1) if (!names.has(`${base} (${i})`)) return `${base} (${i})`;
}
