/**
 * The selected course as the editor shows and edits it
 * (docs/course-editor.md §4): the display sequence (start, controls,
 * finish — the event default completing an implicit start / finish, as
 * every reader does, docs/course-layer.md §6.2), the structure made
 * explicit for the first save, and the leg → insert-position mapping.
 */

import type { course } from "@oxygen/shared";
import { effectiveRoleControlId } from "../course-editor";
import { controlSequence, type KindOf } from "./structure-edit";

type Pt = { x: number; y: number };
type Structure = course.WireCourseStructure;

export interface SiteRow {
  id: number;
  code: string;
  status: number;
  mapX: number;
  mapY: number;
}

export interface DisplayRow {
  kind: "start" | "control" | "finish";
  id: number;
  code: string;
  /** Paper mm; null when the site is not positioned. */
  pt: Pt | null;
  /** Control-sequence position (control rows); −1 for start / finish. */
  seqIndex: number;
}

export const kindOfSites = (sites: readonly SiteRow[]): KindOf => {
  const byId = new Map(sites.map((s) => [s.id, s.status] as const));
  return (id) => (byId.get(id) === 4 ? "start" : byId.get(id) === 5 ? "finish" : "control");
};

const pointOf = (s: SiteRow | undefined): Pt | null => (s && (s.mapX !== 0 || s.mapY !== 0) ? { x: s.mapX, y: s.mapY } : null);

/** The structure's explicit start / finish, or the event default the readers complete it with. */
export function effectiveEnds(s: Structure, sites: readonly SiteRow[]): { start: number | null; finish: number | null } {
  const kindOf = kindOfSites(sites);
  const items = s.items.filter((i) => i.kind !== "variation") as { siteId: number; role?: string }[];
  const first = items[0], last = items[items.length - 1];
  const start = first && (first.role ?? kindOf(first.siteId)) === "start" ? first.siteId : effectiveRoleControlId(sites, "start", null);
  const finish = last && items.length > (start === first?.siteId ? 1 : 0) && (last.role ?? kindOf(last.siteId)) === "finish"
    ? last.siteId
    : effectiveRoleControlId(sites, "finish", null);
  return { start, finish };
}

/** Start, controls, finish: the inspector's rows, the leg metres and the leg mapping. */
export function displaySequence(s: Structure, sites: readonly SiteRow[]): DisplayRow[] {
  const byId = new Map(sites.map((x) => [x.id, x] as const));
  const kindOf = kindOfSites(sites);
  const { start, finish } = effectiveEnds(s, sites);
  const row = (kind: DisplayRow["kind"], id: number, seqIndex: number): DisplayRow => {
    const site = byId.get(id);
    return { kind, id, code: site?.code ?? String(id), pt: pointOf(site), seqIndex };
  };
  const rows: DisplayRow[] = [];
  if (start != null && byId.has(start)) rows.push(row("start", start, -1));
  controlSequence(s, kindOf).forEach((id, i) => rows.push(row("control", id, i)));
  if (finish != null && byId.has(finish)) rows.push(row("finish", finish, -1));
  return rows;
}

/**
 * The structure with the start and finish it is drawn with as explicit
 * items — the editor's first save makes a course explicit
 * (docs/course-layer.md §6.2).
 */
export function explicitStructure(s: Structure, sites: readonly SiteRow[]): Structure {
  const kindOf = kindOfSites(sites);
  const { start, finish } = effectiveEnds(s, sites);
  const items = [...s.items];
  const leads = items[0] && items[0].kind !== "variation" && (items[0].role ?? kindOf(items[0].siteId)) === "start";
  if (!leads && start != null) items.unshift({ siteId: start });
  const tail = items[items.length - 1];
  const trails = items.length > 1 && tail.kind !== "variation" && (tail.role ?? kindOf(tail.siteId)) === "finish";
  if (!trails && finish != null) items.push({ siteId: finish });
  return { ...s, items };
}

/**
 * Leg `legIndex` of the drawn route joins positioned rows `legIndex` and
 * `legIndex + 1` (unpositioned rows skipped, as the layer does): a control
 * placed on it goes before the row the leg ends at, or last when the leg
 * ends at the finish. The first visit wins for a repeated control.
 */
export function insertIndexForLeg(rows: readonly DisplayRow[], legIndex: number): number {
  const controls = rows.filter((r) => r.kind === "control").length;
  const target = rows.filter((r) => r.pt !== null)[legIndex + 1];
  return !target || target.kind !== "control" ? controls : target.seqIndex;
}
