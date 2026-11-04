/**
 * Presence and live refresh in the editor (docs/course-editor.md §11;
 * docs/course-layer.md §7 "Presence and live refresh"): the heartbeat's
 * client id, the top-bar entries ("Anna · Lång · Field"), and the test for a
 * course token that moved under the user's feet.
 */

export type PresenceMode = "course" | "layout" | "field";

export interface PresenceOther {
  courseId: number;
  courseName: string;
  name: string;
  mode: PresenceMode;
}

/** The heartbeat's cadence: the poll's 5 s (`useExternalChanges`), well inside the server's 30 s TTL. */
export const PRESENCE_HEARTBEAT_MS = 5_000;

/** A tab's identity for the heartbeat: random per page load, so two tabs of one user are two entries. */
export function newClientId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export interface PresenceEntry {
  key: string;
  label: string;
  /** On the course the user has open. */
  here: boolean;
}

/** Entries the top bar shows inline; the rest are a "+n" chip (the bar must stay one row: the map under it is the editor). */
export const PRESENCE_INLINE = 2;

/**
 * "Anna · Lång · Field" per other editor, those on the open course first.
 * Identical entries (one user's tabs in one mode) collapse into one, "× n".
 * `anonymous` names a user the server could not name (no sign-in).
 */
export function presenceEntries(
  others: readonly PresenceOther[],
  selectedCourseId: number | null,
  modeLabel: (mode: PresenceMode) => string,
  anonymous: string,
): PresenceEntry[] {
  const merged = new Map<string, PresenceEntry & { n: number }>();
  for (const o of others) {
    const label = [o.name || anonymous, o.courseName, modeLabel(o.mode)].join(" · ");
    const key = `${o.courseId}:${label}`;
    const prev = merged.get(key);
    if (prev) prev.n++;
    else merged.set(key, { key, label, here: o.courseId === selectedCourseId, n: 1 });
  }
  const entries = [...merged.values()].map((e) => ({ key: e.key, label: e.n > 1 ? `${e.label} × ${e.n}` : e.label, here: e.here }));
  return [...entries.filter((e) => e.here), ...entries.filter((e) => !e.here)];
}

/**
 * A course whose token changed without this client having written it: the
 * structure was changed elsewhere and the editor must say so. `prev` is the
 * token last seen (undefined before the first), `own` the tokens this client's
 * writes returned.
 */
export function courseChangedElsewhere(prev: string | undefined, next: string | undefined, own: ReadonlySet<string>): boolean {
  return prev !== undefined && next !== undefined && next !== prev && !own.has(next);
}

/** "12:41" in the viewer's locale for an ISO instant. */
export function clockTime(iso: string, locale?: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}
