/**
 * Edits of a course structure in its wire form (`course.setStructure`,
 * docs/course-layer.md §6; docs/course-editor.md §4). Pure: each returns a
 * new structure, the input is never changed.
 *
 * Positions are **control-sequence** positions — the items between an
 * explicit leading start and an explicit trailing finish (the inspector's
 * rows and the legacy editor's `sequenceIds`). A structure that names no
 * start or finish leaves the event default to the readers (§6.2); edits
 * never add one unless asked (`setRole`).
 *
 * `LegProps` describe the leg *into* an item, so an item whose predecessor
 * changed loses its `leg`: authored gaps of 31 → 32 are not gaps of
 * 40 → 32. Phase 1 has control items only (variation groups are refused
 * by the server until slice F) and they are passed through untouched.
 */

import type { course } from "@oxygen/shared";

type Structure = course.WireCourseStructure;
type Item = Structure["items"][number];
type Role = "start" | "finish" | "control";
export type KindOf = (siteId: number) => Role;

const siteOf = (item: Item): number | null => (item.kind === "variation" ? null : item.siteId);
const roleOf = (item: Item, kindOf: KindOf): Role | null =>
  item.kind === "variation" ? null : (item.role ?? kindOf(item.siteId));

/** [first, end) of the control sequence inside `items`. */
function bounds(items: readonly Item[], kindOf: KindOf): [number, number] {
  const first = items.length > 0 && roleOf(items[0], kindOf) === "start" ? 1 : 0;
  const end = items.length > first && roleOf(items[items.length - 1], kindOf) === "finish" ? items.length - 1 : items.length;
  return [first, end];
}

/** Drops `leg` from every item whose predecessor site changed. */
function withLegs(before: readonly Item[], after: Item[]): Item[] {
  const prevOf = new Map<Item, number | null>();
  before.forEach((item, i) => prevOf.set(item, i > 0 ? siteOf(before[i - 1]) : null));
  return after.map((item, i) => {
    if (item.kind === "variation" || !item.leg || !prevOf.has(item)) return item;
    const prev = i > 0 ? siteOf(after[i - 1]) : null;
    if (prev === prevOf.get(item)) return item;
    const { leg: _leg, ...rest } = item;
    return rest;
  });
}

function edit(s: Structure, items: Item[]): Structure {
  return { ...s, items: withLegs(s.items, items) };
}

/** The control sequence: public ids between the explicit start and finish. */
export function controlSequence(s: Structure, kindOf: KindOf): number[] {
  const [first, end] = bounds(s.items, kindOf);
  return s.items.slice(first, end).flatMap((i) => (i.kind === "variation" ? [] : [i.siteId]));
}

/** Insert a visit of `siteId` at control-sequence position `at` (clamped). */
export function insertSite(s: Structure, at: number, siteId: number, kindOf: KindOf): Structure {
  const [first, end] = bounds(s.items, kindOf);
  const index = first + Math.max(0, Math.min(at, end - first));
  const items = [...s.items];
  items.splice(index, 0, { siteId });
  return edit(s, items);
}

/** Append a visit after the last control (before an explicit finish). */
export function appendSite(s: Structure, siteId: number, kindOf: KindOf): Structure {
  const [first, end] = bounds(s.items, kindOf);
  return insertSite(s, end - first, siteId, kindOf);
}

/** Remove every visit of `siteId` (membership, not the site). */
export function removeSite(s: Structure, siteId: number): Structure {
  return edit(s, s.items.filter((i) => siteOf(i) !== siteId));
}

/** Remove the one visit at control-sequence position `at` (the inspector's ✕). */
export function removeVisit(s: Structure, at: number, kindOf: KindOf): Structure {
  const [first, end] = bounds(s.items, kindOf);
  if (at < 0 || at >= end - first) return s;
  const items = [...s.items];
  items.splice(first + at, 1);
  return edit(s, items);
}

/** Move the visit at control-sequence position `from` to position `to` (clamped). */
export function moveVisit(s: Structure, from: number, to: number, kindOf: KindOf): Structure {
  const [first, end] = bounds(s.items, kindOf);
  const n = end - first;
  if (from < 0 || from >= n) return s;
  const items = [...s.items];
  const [moved] = items.splice(first + from, 1);
  items.splice(first + Math.max(0, Math.min(to, n - 1)), 0, moved);
  return edit(s, items);
}

/** Make `siteId` the course's explicit start or finish: replaces the one there, or adds it. */
export function setRole(s: Structure, role: "start" | "finish", siteId: number, kindOf: KindOf): Structure {
  const [first, end] = bounds(s.items, kindOf);
  const items = [...s.items];
  if (role === "start") {
    if (first === 1) items[0] = { siteId };
    else items.unshift({ siteId });
  } else if (end === items.length - 1) items[end] = { siteId };
  else items.push({ siteId });
  return edit(s, items);
}

/** Hide (or show) the number of every visit of `siteId` (`numberHidden`, 08 §4.2; docs/course-editor.md §6.6). */
export function setNumberHidden(s: Structure, siteId: number, hidden: boolean): Structure {
  return {
    ...s,
    items: s.items.map((i) => {
      if (i.kind === "variation" || i.siteId !== siteId) return i;
      if (hidden) return { ...i, numberHidden: true };
      const { numberHidden: _h, ...rest } = i;
      return rest;
    }),
  };
}

/**
 * The gaps of the leg into item `index` (an index into `items`; the legs of
 * docs/course-layer.md §2, fractions of the centre-to-centre leg). An empty
 * list drops them (the automatic gaps again), and a `leg` left empty goes.
 */
export function setLegGaps(s: Structure, index: number, gaps: { from: number; to: number }[]): Structure {
  const item = s.items[index];
  if (!item || item.kind === "variation" || index === 0) return s;
  const { gaps: _g, ...legRest } = item.leg ?? {};
  const leg = gaps.length > 0 ? { ...legRest, gaps } : legRest;
  const { leg: _l, ...itemRest } = item;
  const items = [...s.items];
  items[index] = Object.keys(leg).length > 0 ? { ...itemRest, leg } : itemRest;
  return { ...s, items };
}
