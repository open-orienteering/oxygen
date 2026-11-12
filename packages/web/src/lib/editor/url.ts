/**
 * The course editor's URL (docs/course-editor.md §1 "URL"; F31,
 * feedback-2026-11-11-merge.md item 4 and answers 1–2).
 *
 * The query string follows the editor's key modes and is written with
 * history `replace`, never `push`, so Back leaves the editor in one step and
 * a reload or a shared link restores the state:
 *
 * - `course=<seq>` — the selected course;
 * - `mode=layout|field` — absent is Course (a phone with no `mode` opens Field,
 *   so a phone in Course mode writes `mode=course`; Layout is not a phone mode);
 * - `view=all|class|variant|all-variations` — absent is Course view, with
 *   `class=<seq>` (Class view) and `variant=<key>` (Variant view; also the
 *   variant Class view and Layout draw, F8);
 * - `sheet=<seq>` / `template=<seq>` — Layout mode's sheet or template.
 *
 * `control=<id>` is an inbound link only (the Controls page): it is read
 * once and dropped from the next write. The tool, the selection and the
 * preferences are never written. Defaults are omitted.
 *
 * `parseEditorUrl` checks the syntax: a value that cannot be one of these is
 * dropped and named in `invalid`. Whether a course, class, variant, sheet or
 * template exists is the editor's to check once its data has loaded; what it
 * does not take is simply absent from the state `editorSearchFor` writes.
 */

import type { EditorMode, EditorView } from "./state";

/** The URL's part of the editor state. */
export interface EditorUrlState {
  course: number | null;
  /** null: no `mode` in the URL (the device's initial mode). */
  mode: EditorMode | null;
  view: EditorView;
  classSeq: number | null;
  variantKey: string | null;
  /** Layout mode's sheet or template; null outside Layout or when Layout shows its default. */
  layout: { sheet: number } | { template: number } | null;
}

export interface ParsedEditorUrl extends EditorUrlState {
  /** The inbound control link (`control=<id>`), never written back. */
  control: number | null;
  /** The params whose value was dropped (their names). */
  invalid: string[];
}

/** Every query param the editor owns; others are left as they are. */
export const EDITOR_URL_PARAMS = ["course", "mode", "view", "class", "variant", "sheet", "template", "control"] as const;

const MODES: readonly EditorMode[] = ["course", "layout", "field"];
const VIEWS: readonly EditorView[] = ["course", "all", "class", "variant", "all-variations"];
/** A variant key (`AC`, `ABA`): its groups' labels; the course's variant list decides whether it is one. */
const VARIANT_KEY = /^\S{1,64}$/;

function positiveInt(raw: string | null): number | null | undefined {
  if (raw === null) return undefined;
  if (!/^[1-9][0-9]{0,8}$/.test(raw)) return null;
  return Number(raw);
}

/** The editor's state as the URL gives it, its invalid params dropped. */
export function parseEditorUrl(search: URLSearchParams | string): ParsedEditorUrl {
  const q = typeof search === "string" ? new URLSearchParams(search) : search;
  const invalid: string[] = [];
  const int = (name: string): number | null => {
    const v = positiveInt(q.get(name));
    if (v === null) invalid.push(name);
    return v ?? null;
  };

  const course = int("course");
  const control = int("control");

  const rawMode = q.get("mode");
  let mode: EditorMode | null = null;
  if (rawMode !== null) {
    if ((MODES as readonly string[]).includes(rawMode)) mode = rawMode as EditorMode;
    else invalid.push("mode");
  }

  const rawView = q.get("view");
  let view: EditorView = "course";
  if (rawView !== null) {
    if ((VIEWS as readonly string[]).includes(rawView)) view = rawView as EditorView;
    else invalid.push("view");
  }

  // Class view needs its class; a class without Class view is not one.
  let classSeq = int("class");
  if (view === "class" && classSeq === null) {
    view = "course";
    if (!invalid.includes("view")) invalid.push("view");
  } else if (view !== "class" && classSeq !== null) {
    classSeq = null;
    invalid.push("class");
  }

  // Variant view needs its key; Class view and Layout may carry one (F8); elsewhere it is not one.
  const rawVariant = q.get("variant");
  let variantKey: string | null = null;
  if (rawVariant !== null) {
    if (VARIANT_KEY.test(rawVariant)) variantKey = rawVariant;
    else invalid.push("variant");
  }
  if (view === "variant" && variantKey === null) {
    view = "course";
    if (!invalid.includes("view")) invalid.push("view");
  } else if (variantKey !== null && view !== "variant" && view !== "class" && mode !== "layout") {
    variantKey = null;
    invalid.push("variant");
  }

  // Layout's sheet or template: only in Layout mode, one of the two (the sheet wins, as the link always had it).
  const sheet = int("sheet"), template = int("template");
  let layout: EditorUrlState["layout"] = null;
  if (mode === "layout") {
    if (sheet !== null) {
      layout = { sheet };
      if (template !== null) invalid.push("template");
    } else if (template !== null) layout = { template };
  } else {
    if (sheet !== null) invalid.push("sheet");
    if (template !== null) invalid.push("template");
  }

  return { course, mode, view, classSeq, variantKey, layout, control, invalid };
}

/** How the page writes: on a phone Course mode is not the default; a variant key that is the first is (F8). */
export interface EditorSearchOptions {
  phone?: boolean;
  /** The selected course's first variant key: Class view's and Layout's default, omitted. */
  firstVariant?: string | null;
}

/**
 * The query string for a state (without `?`, empty for the defaults), in a
 * fixed order. `keep` carries params the editor does not own through
 * unchanged; every editor param not in the state is dropped, `control` always.
 */
export function editorSearchFor(s: EditorUrlState, keep?: URLSearchParams | string, opts: EditorSearchOptions = {}): string {
  const q = new URLSearchParams();
  if (s.course !== null) q.set("course", String(s.course));
  if (s.mode === "layout" || s.mode === "field" || (s.mode === "course" && opts.phone)) q.set("mode", s.mode);
  if (s.view !== "course") q.set("view", s.view);
  if (s.view === "class" && s.classSeq !== null) q.set("class", String(s.classSeq));
  if (s.variantKey !== null && (s.view === "variant" || ((s.view === "class" || s.mode === "layout") && s.variantKey !== opts.firstVariant))) {
    q.set("variant", s.variantKey);
  }
  if (s.mode === "layout" && s.layout) {
    if ("sheet" in s.layout) q.set("sheet", String(s.layout.sheet));
    else q.set("template", String(s.layout.template));
  }
  if (keep !== undefined) {
    const other = typeof keep === "string" ? new URLSearchParams(keep) : keep;
    for (const [k, v] of other) if (!(EDITOR_URL_PARAMS as readonly string[]).includes(k)) q.append(k, v);
  }
  return q.toString();
}

/** What `checkInbound` needs of a query (React Query's result). */
export interface InboundQuery {
  isFetchedAfterMount: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => unknown;
}

/**
 * Whether an inbound param names something in a query's data: `true` when
 * `found` (the cache may answer), `false` only once the query has fetched
 * since the page mounted or failed, `null` while that is pending. The cache
 * is persisted (offline-first) and fresh for a few seconds, so a link to
 * something created since the last answer — a new sheet, a new course — may
 * not be in it: the caller fetches (`fetchIfIdle`) and asks again.
 */
export function checkInbound(found: boolean, q: InboundQuery): boolean | null {
  if (found) return true;
  if (q.isFetchedAfterMount || q.isError) return false;
  return null;
}

/** Fetch a query `checkInbound` is waiting on, unless it is already fetching. Call it from an effect. */
export function fetchIfIdle(q: InboundQuery): void {
  if (!q.isFetching) void q.refetch();
}
