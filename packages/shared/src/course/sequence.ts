/**
 * The one sequence rule of every course reader (docs/course-layer.md §6.2
 * "Readers") and the column split of a stored structure (§6): pure
 * functions over a structure and site rows, shared by the API (columns,
 * export, checks) and the print pipeline's layout half, which runs in the
 * browser too (docs/course-print.md §1, G13).
 */

import { type StoredControlItem as ControlItem, courseStructureSchema, structureControlItems } from "./structure.js";


export interface StructureParts {
  /** Explicit start site, or null (the event default unless `firstAsStart`). */
  start: string | null;
  /** Explicit finish site, or null (the event default unless `lastAsFinish`). */
  finish: string | null;
  /** The `course_controls` sequence. */
  middle: ControlItem[];
  firstAsStart: boolean;
  lastAsFinish: boolean;
}

/** Split a structure's control items into the column mirror (docs/course-layer.md §6: start, finish, the `course_controls` sequence, the flags). */
export function splitStructure(
  items: readonly ControlItem[],
  kindOf: (siteId: string) => string | undefined,
): StructureParts {
  const middle = [...items];
  let start: string | null = null;
  let finish: string | null = null;
  let firstAsStart = false;
  let lastAsFinish = false;
  const first = middle[0];
  if (first && kindOf(first.siteId) === "start") {
    start = first.siteId;
    middle.shift();
  } else if (first?.role === "start") {
    firstAsStart = true;
  }
  const last = middle.at(-1);
  if (last && kindOf(last.siteId) === "finish") {
    finish = last.siteId;
    middle.pop();
  } else if (last?.role === "finish") {
    lastAsFinish = true;
  }
  return { start, finish, middle, firstAsStart, lastAsFinish };
}

/** A site's kind from its row: `kind`, else the legacy `status` 4 / 5. */
export function rowKind(c: { kind: string; status: string }): string {
  if (c.kind !== "control") return c.kind;
  return c.status === "start" || c.status === "finish" ? c.status : "control";
}

/** A `controls` row as the sequence readers need it. */
export interface SequenceSite {
  id: string;
  name: string;
  kind: string;
  status: string;
}

/** The course columns the sequence rule reads (`structure` raw JSONB). */
export interface SequenceColumns {
  structure: unknown;
  startName: string;
  finishControlId: string | null;
  firstAsStart: boolean;
  lastAsFinish: boolean;
}

export interface CourseSequenceParts<R> {
  /** The start drawn before the sequence: the explicit one, else the event's first; null under `firstAsStart` or without starts. */
  start: R | null;
  /** Site ids between start and finish (a variation by its first alternative); the caller drops the ones it has no live row for. */
  middle: string[];
  /** As `start`, for the finish. */
  finish: R | null;
  firstAsStart: boolean;
  lastAsFinish: boolean;
  /** Read from a valid stored `structure` (else from the columns). */
  fromStructure: boolean;
}

/**
 * The one sequence rule of every course reader (docs/course-layer.md §6.2
 * "Readers"): the explicit start, the sequence and the explicit finish
 * from the stored structure when one is valid, from the columns otherwise
 * (`start_name`, `course_controls`, `finish_control_id`, the flags — what
 * the editor reads for a NULL structure through `structureFromColumns`);
 * an absent start / finish is completed by the event's first (lowest seq)
 * one unless `firstAsStart` / `lastAsFinish`. `site` resolves live rows
 * only, so a soft-deleted explicit site falls back to the default as a
 * deleted start's name does; `starts` / `finishes` are the event's live
 * ones, lowest seq first.
 */
export function courseSequenceOf<R extends SequenceSite>(
  c: SequenceColumns,
  courseControlIds: readonly string[],
  sites: { site: (id: string) => R | undefined; starts: readonly R[]; finishes: readonly R[] },
): CourseSequenceParts<R> {
  const parsed = c.structure ? courseStructureSchema.safeParse(c.structure) : null;
  let explicitStart: R | undefined;
  let explicitFinish: R | undefined;
  let firstAsStart = c.firstAsStart;
  let lastAsFinish = c.lastAsFinish;
  let middle: string[];
  if (parsed?.success) {
    const parts = splitStructure(structureControlItems(parsed.data), (id) => {
      const r = sites.site(id);
      return r ? rowKind(r) : undefined;
    });
    explicitStart = parts.start ? sites.site(parts.start) : undefined;
    explicitFinish = parts.finish ? sites.site(parts.finish) : undefined;
    firstAsStart = parts.firstAsStart;
    lastAsFinish = parts.lastAsFinish;
    middle = parts.middle.map((item) => item.siteId);
  } else {
    explicitStart = c.startName ? sites.starts.find((s) => s.name === c.startName) : undefined;
    explicitFinish = c.finishControlId ? sites.finishes.find((f) => f.id === c.finishControlId) : undefined;
    middle = [...courseControlIds];
  }
  return {
    start: firstAsStart ? null : explicitStart ?? sites.starts[0] ?? null,
    middle,
    finish: lastAsFinish ? null : explicitFinish ?? sites.finishes[0] ?? null,
    firstAsStart,
    lastAsFinish,
    fromStructure: !!parsed?.success,
  };
}

/**
 * The legs through crossing points of a stored structure, as the
 * description sheet derives its 13.3 / 13.4 rows from them
 * (`buildDescriptionSheet`'s `crossings`; course-layer.md §10.3): each
 * anchored after the item the leg leaves — its public id, `null` when
 * that item is the start (by role, else the first item of a course whose
 * first site is a start). The root's path: a group by its first
 * alternative, as `structureControlItems`.
 */
export function crossingRowsOf(
  stored: unknown,
  publicId: (uuid: string) => number | undefined,
  isStart: (uuid: string) => boolean = () => false,
): { afterControlId: number | null; section: boolean }[] {
  const parsed = stored ? courseStructureSchema.safeParse(stored) : null;
  if (!parsed?.success) return [];
  const items = structureControlItems(parsed.data);
  const out: { afterControlId: number | null; section: boolean }[] = [];
  items.forEach((item, i) => {
    if (i === 0 || !item.leg?.crossing) return;
    const from = items[i - 1];
    const start = from.role === "start" || (from.role === undefined && i - 1 === 0 && isStart(from.siteId));
    const anchor = start ? null : publicId(from.siteId);
    if (anchor === undefined) return;
    out.push({ afterControlId: anchor, section: !!item.leg.crossing.section });
  });
  return out;
}
