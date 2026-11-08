/**
 * The selected course as the editor shows and edits it
 * (docs/course-editor.md §4): the display sequence (start, controls,
 * finish — the event default completing an implicit start / finish, as
 * every reader does, docs/course-layer.md §6.2), the structure made
 * explicit for the first save, and the leg → insert-position mapping.
 */

import type { course } from "@oxygen/shared";
import { effectiveRoleControlId } from "../course-editor";
import { displayPath, type GroupOrders, type KindOf, type RowPath } from "./structure-edit";

type Pt = { x: number; y: number };
type Structure = course.WireCourseStructure;

export interface SiteRow {
  id: number;
  code: string;
  status: number;
  mapX: number;
  mapY: number;
  /** `controls.kind` (course-layer.md §6.3); absent reads as the status's. */
  kind?: string;
}

export interface DisplayRow {
  kind: "start" | "control" | "finish";
  id: number;
  code: string;
  /** Paper mm; null when the site is not positioned. */
  pt: Pt | null;
  /** Control-sequence position (control rows); −1 for start / finish. */
  seqIndex: number;
  /** A control row whose site is a map exchange (§6.9): it ends one part and opens the next. */
  exchange?: boolean;
  /** Where the row comes from in the explicit structure (§12): a top-level item, an alternative's, a loop's anchor visit. */
  path: RowPath;
  /** A row inside a variation group (§12): the group, and the alternative it belongs to (none for an anchor visit). */
  group?: { id: string; label: string | null; loop: boolean };
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

/**
 * Start, controls, finish: the inspector's rows, the leg metres and the leg
 * mapping — of the displayed path (§12): each variation group shown by the
 * alternatives `orders` names (default the first; a loop every one, its
 * anchor visited between them). Row paths index the explicit structure.
 */
export function displaySequence(s: Structure, sites: readonly SiteRow[], orders?: GroupOrders): DisplayRow[] {
  const byId = new Map(sites.map((x) => [x.id, x] as const));
  const kindOf = kindOfSites(sites);
  const explicit = explicitStructure(s, sites);
  const p = displayPath(explicit, kindOf, orders);
  const rows: DisplayRow[] = [];
  p.items.forEach((item, i) => {
    const kind: DisplayRow["kind"] = i < p.first ? "start" : i >= p.end ? "finish" : "control";
    const site = byId.get(item.siteId);
    // A start / finish whose site is not among the event's controls has no row (§6.7).
    if (kind !== "control" && !site) return;
    const path = p.paths[i];
    const out: DisplayRow = { kind, id: item.siteId, code: site?.code ?? String(item.siteId), pt: pointOf(site), seqIndex: kind === "control" ? i - p.first : -1, path };
    if (kind === "control" && site?.kind === "map_exchange") out.exchange = true;
    const group = explicit.items[path.itemIndex];
    if ((path.alt || path.anchorVisit) && group?.kind === "variation") out.group = { id: group.id, label: path.alt?.label ?? null, loop: !!group.loop };
    rows.push(out);
  });
  return rows;
}

/** Course view's orders (§12): each group by its active alternative (default the first); a loop with it first, then the rest. */
export function courseViewOrders(s: Structure, active: Readonly<Record<string, string>>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const item of s.items) {
    if (item.kind !== "variation") continue;
    const labels = item.alternatives.map((a) => a.label);
    const first = labels.includes(active[item.id]) ? active[item.id] : labels[0];
    out[item.id] = item.loop ? [first, ...labels.filter((l) => l !== first)] : [first];
  }
  return out;
}

/** A variation group as the inspector shows it (§12): its block goes after row `afterRow` (the anchor's). */
export interface VariationBlockInfo {
  id: string;
  /** The group's index in the explicit structure's items. */
  itemIndex: number;
  labels: string[];
  loop: boolean;
  /** The alternative shown first (Course view: the active one). */
  active: string;
  /** Controls per alternative label. */
  counts: Record<string, number>;
  afterRow: number;
}

/** The groups of the displayed structure, each placed after its anchor's row (−1 when the anchor has no row). */
export function variationBlocks(s: Structure, sites: readonly SiteRow[], rows: readonly DisplayRow[], orders?: GroupOrders): VariationBlockInfo[] {
  const explicit = explicitStructure(s, sites);
  const out: VariationBlockInfo[] = [];
  explicit.items.forEach((item, itemIndex) => {
    if (item.kind !== "variation") return;
    const labels = item.alternatives.map((a) => a.label);
    const named = orders?.[item.id]?.find((l) => labels.includes(l));
    out.push({
      id: item.id,
      itemIndex,
      labels,
      loop: !!item.loop,
      active: named ?? labels[0],
      counts: Object.fromEntries(item.alternatives.map((a) => [a.label, a.items.length])),
      afterRow: rows.findIndex((r) => r.path.itemIndex === itemIndex - 1 && !r.path.alt && !r.path.anchorVisit),
    });
  });
  return out;
}

/**
 * The control-sequence position at the end of alternative `label` of the
 * group at `itemIndex` (§12: `K` armed with an alternative active inserts
 * into it): after its last displayed row, else after the anchor (the
 * straight leg of an empty active alternative). Null when neither has a row.
 */
export function alternativeEndAt(rows: readonly DisplayRow[], itemIndex: number, label: string): number | null {
  const own = rows.filter((r) => r.path.itemIndex === itemIndex && r.path.alt?.label === label);
  if (own.length > 0) return own[own.length - 1].seqIndex + 1;
  const anchor = rows.find((r) => r.path.itemIndex === itemIndex - 1 && !r.path.alt && !r.path.anchorVisit);
  if (!anchor) return null;
  return anchor.kind === "start" ? 0 : anchor.seqIndex + 1;
}

/**
 * The sequence's part headings (docs/course-editor.md §6.9; course-layer.md
 * §11): by row index, the part number (1-based) whose heading goes before
 * that row — part 1 before the first row, part n + 1 after the n-th
 * exchange row (the exchange ends one part and opens the next). Empty when
 * the course has no exchange.
 */
export function partHeadings(rows: readonly DisplayRow[]): Map<number, number> {
  const out = new Map<number, number>();
  if (!rows.some((r) => r.exchange)) return out;
  out.set(0, 1);
  let part = 1;
  rows.forEach((r, i) => {
    if (r.exchange) out.set(i + 1, ++part);
  });
  return out;
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

/**
 * The leg a leg-click phantom's insert position names (docs/course-editor.md
 * §4, §6.7): `itemIndex` is the index of the row the leg runs into, `path`
 * that row's item in the explicit structure (the leg into it is its `leg`;
 * a loop's anchor visit has none, §12) and `from` the positioned row before
 * it. The inverse of `insertIndexForLeg`; null when either end has no point.
 */
export function legForInsert(rows: readonly DisplayRow[], insertAt: number): { itemIndex: number; path: RowPath; from: DisplayRow; to: DisplayRow } | null {
  const controls = rows.filter((r) => r.kind === "control").length;
  const itemIndex = rows.findIndex((r) => (r.kind === "control" ? r.seqIndex === insertAt : r.kind === "finish" && insertAt >= controls));
  const to = rows[itemIndex];
  const from = rows.slice(0, Math.max(0, itemIndex)).reverse().find((r) => r.pt);
  if (itemIndex < 0 || !to?.pt || !from) return null;
  return { itemIndex, path: to.path, from, to };
}
