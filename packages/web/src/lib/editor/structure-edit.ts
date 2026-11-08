/**
 * Edits of a course structure in its wire form (`course.setStructure`,
 * docs/course-layer.md §6; docs/course-editor.md §4, §12). Pure: each
 * returns a new structure, the input is never changed.
 *
 * Positions are **control-sequence** positions of the *displayed path* —
 * the items between an explicit leading start and an explicit trailing
 * finish (the inspector's rows), each variation group shown by the
 * alternatives `orders` names (`course.pathOfOrders`; Course view: the
 * active alternative, Variant view: the variant's order; default the
 * first). A structure that names no start or finish leaves the event
 * default to the readers (§6.2); edits never add one unless asked
 * (`setRole`).
 *
 * Inserting on a leg of a group (§12) goes into the group: the leg into an
 * alternative's control or out of its last one splits that alternative,
 * the straight leg of an empty active alternative fills it. A loop's
 * repeated anchor visit is no item: it takes no ✕, no move and no leg.
 *
 * `LegProps` describe the leg *into* an item, so an item whose predecessor
 * changed loses its `leg`: authored gaps of 31 → 32 are not gaps of
 * 40 → 32. The item after a group keeps its leg while the group changes
 * (its predecessor is the group). A group left unanchored or next to
 * another dissolves into its first alternative (the schema's rule, as
 * `course.pruneSiteFromStructure`); a group whose alternatives are all
 * empty stays (F7: valid, straight legs).
 */

import { course } from "@oxygen/shared";

type Structure = course.WireCourseStructure;
type Item = Structure["items"][number];
type Control = Extract<Item, { siteId: number }>;
type Group = Extract<Item, { kind: "variation" }>;
type Role = "start" | "finish" | "control";
export type KindOf = (siteId: number) => Role;
export type GroupOrders = course.GroupOrders;
export type RowPath = course.RowPath;

const roleOf = (item: Item, kindOf: KindOf): Role | null =>
  item.kind === "variation" ? null : (item.role ?? kindOf(item.siteId));

/** [first, end) of the control sequence inside `items` (top level: start and finish are never in a group). */
function bounds(items: readonly Item[], kindOf: KindOf): [number, number] {
  const first = items.length > 0 && roleOf(items[0], kindOf) === "start" ? 1 : 0;
  const end = items.length > first && roleOf(items[items.length - 1], kindOf) === "finish" ? items.length - 1 : items.length;
  return [first, end];
}

/** The displayed path (`course.pathOfOrders`) and its control-sequence bounds `[first, end)`. */
export function displayPath(s: Structure, kindOf: KindOf, orders?: GroupOrders): { items: Control[]; paths: RowPath[]; first: number; end: number } {
  return pathOf(s, kindOf, orders);
}

function pathOf(s: Structure, kindOf: KindOf, orders?: GroupOrders) {
  const path = course.pathOfOrders<Control>(s, orders);
  const n = path.items.length;
  const top = (i: number) => path.paths[i] && path.paths[i].alt === undefined && !path.paths[i].anchorVisit;
  const first = n > 0 && top(0) && (path.items[0].role ?? kindOf(path.items[0].siteId)) === "start" ? 1 : 0;
  const end = n > first && top(n - 1) && (path.items[n - 1].role ?? kindOf(path.items[n - 1].siteId)) === "finish" ? n - 1 : n;
  return { ...path, first, end };
}

/** Every control item with the key of the item before it (`s:<site>`, `g:<group>` for the item after a group). */
function predecessors(items: readonly Item[]): Map<Control, string | null> {
  const out = new Map<Control, string | null>();
  items.forEach((item, i) => {
    const prev = items[i - 1];
    const prevKey = !prev ? null : prev.kind === "variation" ? `g:${prev.id}` : `s:${prev.siteId}`;
    if (item.kind !== "variation") {
      out.set(item, prevKey);
      return;
    }
    const anchor = prev && prev.kind !== "variation" ? `s:${prev.siteId}` : null;
    for (const alt of item.alternatives) {
      alt.items.forEach((c, j) => out.set(c, j === 0 ? anchor : `s:${alt.items[j - 1].siteId}`));
    }
  });
  return out;
}

const withoutLeg = (c: Control): Control => {
  const { leg: _leg, ...rest } = c;
  return rest;
};

/** Drops `leg` from every control item (top level or in an alternative) whose predecessor changed. */
function withLegs(before: readonly Item[], after: Item[]): Item[] {
  const was = predecessors(before);
  const now = predecessors(after);
  const fix = (c: Control): Control => (c.leg && was.has(c) && was.get(c) !== now.get(c) ? withoutLeg(c) : c);
  return after.map((item) =>
    item.kind === "variation"
      ? { ...item, alternatives: item.alternatives.map((alt) => ({ ...alt, items: alt.items.map(fix) })) }
      : fix(item),
  );
}

/** Groups left first, last or right after another group dissolve into their first alternative (the schema's rule). */
function normalise(items: Item[]): Item[] {
  let out = items;
  for (;;) {
    const bad = out.findIndex((item, i) => item.kind === "variation" && (i === 0 || i === out.length - 1 || out[i - 1].kind === "variation"));
    if (bad < 0) return out;
    const group = out[bad] as Group;
    out = [...out.slice(0, bad), ...group.alternatives[0].items, ...out.slice(bad + 1)];
  }
}

function edit(s: Structure, items: Item[]): Structure {
  return { ...s, items: withLegs(s.items, normalise(items)) };
}

/** A copy of `items` with group `index`'s alternative `label` replaced by `fn(items)`. */
function withAlternative(items: readonly Item[], index: number, label: string, fn: (alt: Control[]) => Control[]): Item[] {
  return items.map((item, i) =>
    i !== index || item.kind !== "variation"
      ? item
      : { ...item, alternatives: item.alternatives.map((alt) => (alt.label === label ? { ...alt, items: fn([...alt.items]) } : alt)) },
  );
}

/** The control item a path row names; undefined for a loop's anchor visit or a stale path. */
export function itemAtPath(s: Structure, path: RowPath): Control | undefined {
  const item = s.items[path.itemIndex];
  if (!item || path.anchorVisit) return undefined;
  if (path.alt) return item.kind === "variation" ? item.alternatives.find((a) => a.label === path.alt!.label)?.items[path.alt.index] : undefined;
  return item.kind === "variation" ? undefined : item;
}

/** The control sequence of the displayed path: public ids between the explicit start and finish. */
export function controlSequence(s: Structure, kindOf: KindOf, orders?: GroupOrders): number[] {
  const p = pathOf(s, kindOf, orders);
  return p.items.slice(p.first, p.end).map((i) => i.siteId);
}

/**
 * Where an item inserted before path row `t` goes (the rules in the
 * header). `top`: a row moved from the top level stays there at a group's
 * boundary (before its anchor's successor, or after the group), so ↑ / ↓
 * past a group never pull a control into it.
 */
type Slot = { top: number } | { group: number; label: string; index: number };
function slotBefore(s: Structure, paths: readonly RowPath[], t: number, orders?: GroupOrders, prefer: "group" | "top" = "group"): Slot {
  const prev = paths[t - 1];
  const next = paths[t];
  const isTop = (p: RowPath | undefined) => !!p && !p.alt && !p.anchorVisit;
  if (prefer === "top") {
    if (!next || isTop(next)) return { top: next ? next.itemIndex : prev ? prev.itemIndex + 1 : 0 };
    if (isTop(prev)) return { top: prev!.itemIndex + 1 };
  }
  if (prev && isTop(prev)) {
    const group = s.items[prev.itemIndex + 1];
    if (group?.kind === "variation") {
      const active = course.groupOrder(group, orders)[0];
      // A loop's empty petal has no leg of its own: a drawn petal's leg after the anchor stays that petal's.
      const drawnPetal = group.loop && next?.alt !== undefined && next.itemIndex === prev.itemIndex + 1;
      if (active && active.items.length === 0 && !drawnPetal) return { group: prev.itemIndex + 1, label: active.label, index: 0 };
    }
  }
  if (next?.alt) return { group: next.itemIndex, label: next.alt.label, index: next.alt.index };
  if (prev?.alt) return { group: prev.itemIndex, label: prev.alt.label, index: prev.alt.index + 1 };
  return { top: next ? next.itemIndex : prev ? prev.itemIndex + 1 : 0 };
}

function placeAt(items: readonly Item[], slot: Slot, item: Control): Item[] {
  if ("top" in slot) {
    const out = [...items];
    out.splice(slot.top, 0, item);
    return out;
  }
  return withAlternative(items, slot.group, slot.label, (alt) => {
    alt.splice(slot.index, 0, item);
    return alt;
  });
}

/** Insert `item` at control-sequence position `at` of the displayed path (clamped). */
function insertItem(s: Structure, at: number, item: Control, kindOf: KindOf, orders?: GroupOrders, prefer: "group" | "top" = "group"): Item[] {
  const p = pathOf(s, kindOf, orders);
  const t = p.first + Math.max(0, Math.min(at, p.end - p.first));
  return placeAt(s.items, slotBefore(s, p.paths, t, orders, prefer), item);
}

/** Insert a visit of `siteId` at control-sequence position `at` of the displayed path (clamped). */
export function insertSite(s: Structure, at: number, siteId: number, kindOf: KindOf, orders?: GroupOrders): Structure {
  return edit(s, insertItem(s, at, { siteId }, kindOf, orders));
}

/** Append a visit after the last control at the top level (before an explicit finish). */
export function appendSite(s: Structure, siteId: number, kindOf: KindOf): Structure {
  const [, end] = bounds(s.items, kindOf);
  const items = [...s.items];
  items.splice(end, 0, { siteId });
  return edit(s, items);
}

/** Remove every visit of `siteId` (membership, not the site), in every alternative too. */
export function removeSite(s: Structure, siteId: number): Structure {
  const items = s.items
    .filter((i) => i.kind === "variation" || i.siteId !== siteId)
    .map((i) => (i.kind === "variation" ? { ...i, alternatives: i.alternatives.map((a) => ({ ...a, items: a.items.filter((c) => c.siteId !== siteId) })) } : i));
  return edit(s, items);
}

/** The items without the row at path index `t`; null for an anchor visit. */
function withoutRow(s: Structure, path: RowPath): { items: Item[]; item: Control } | null {
  const item = itemAtPath(s, path);
  if (!item) return null;
  if (path.alt) {
    const { label, index } = path.alt;
    return { item, items: withAlternative(s.items, path.itemIndex, label, (alt) => alt.filter((_, j) => j !== index)) };
  }
  return { item, items: s.items.filter((_, i) => i !== path.itemIndex) };
}

/** Remove the one visit at control-sequence position `at` (the inspector's ✕); an anchor visit is not removable. */
export function removeVisit(s: Structure, at: number, kindOf: KindOf, orders?: GroupOrders): Structure {
  const p = pathOf(s, kindOf, orders);
  if (at < 0 || at >= p.end - p.first) return s;
  const out = withoutRow(s, p.paths[p.first + at]);
  return out ? edit(s, out.items) : s;
}

/** Move the visit at control-sequence position `from` to position `to` of the displayed path (clamped). */
export function moveVisit(s: Structure, from: number, to: number, kindOf: KindOf, orders?: GroupOrders): Structure {
  const p = pathOf(s, kindOf, orders);
  if (from < 0 || from >= p.end - p.first) return s;
  const row = p.paths[p.first + from];
  const out = withoutRow(s, row);
  if (!out) return s;
  const reduced = { ...s, items: out.items };
  return edit(s, insertItem(reduced, to, out.item, kindOf, orders, row.alt ? "group" : "top"));
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

/** Hide (or show) the number of every visit of `siteId`, in every alternative (`numberHidden`, 08 §4.2; docs/course-editor.md §6.6). */
export function setNumberHidden(s: Structure, siteId: number, hidden: boolean): Structure {
  const one = (i: Control): Control => {
    if (i.siteId !== siteId) return i;
    if (hidden) return { ...i, numberHidden: true };
    const { numberHidden: _h, ...rest } = i;
    return rest;
  };
  return {
    ...s,
    items: s.items.map((i) => (i.kind === "variation" ? { ...i, alternatives: i.alternatives.map((a) => ({ ...a, items: a.items.map(one) })) } : one(i))),
  };
}

type LegProps = NonNullable<Control["leg"]>;
/** *Add corridor* and the `A` menu's *Corridor on selected leg* (§6.7): a band visible at once (decision log, F3). */
export const DEFAULT_CORRIDOR: NonNullable<LegProps["corridor"]> = { widthM: 50, edge: true, whiteMm: 5, whiteOpacity: 1 };

/** A patch of `LegProps`: a key set to `undefined` is removed. */
export type LegPatch = { [K in keyof LegProps]?: LegProps[K] | undefined };

/**
 * Patch the leg into the item at `at` — an index into `items`, or a path
 * row (an alternative's item, §12) — (`LegProps`, 08 §4.3,
 * docs/course-editor.md §6.7): the patch's keys replace the item's, its
 * other leg props stay. A key set to `undefined`, `style: "line"` (the
 * default) and an empty `bends` list are removed, and a leg left empty
 * goes. The first item (no leg into it), a group and a loop's anchor visit
 * are returned unchanged.
 */
export function setLegProps(s: Structure, at: number | RowPath, patch: LegPatch): Structure {
  const path: RowPath = typeof at === "number" ? { itemIndex: at } : at;
  const item = itemAtPath(s, path);
  if (!item || (!path.alt && path.itemIndex === 0)) return s;
  const leg: Record<string, unknown> = { ...(item.leg ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    const drop = value === undefined || (key === "style" && value === "line") || (key === "bends" && Array.isArray(value) && value.length === 0);
    if (drop) delete leg[key];
    else leg[key] = value;
  }
  const { leg: _l, ...itemRest } = item;
  const next: Control = Object.keys(leg).length > 0 ? { ...itemRest, leg: leg as LegProps } : itemRest;
  if (path.alt) {
    const { label, index } = path.alt;
    return { ...s, items: withAlternative(s.items, path.itemIndex, label, (alt) => alt.map((c, j) => (j === index ? next : c))) };
  }
  const items = [...s.items];
  items[path.itemIndex] = next;
  return { ...s, items };
}

/**
 * The gaps of the leg into the item at `at` (fractions of the bent leg,
 * docs/course-editor.md §6.3). An empty list drops them (the automatic
 * gaps again), and a `leg` left empty goes.
 */
export function setLegGaps(s: Structure, at: number | RowPath, gaps: { from: number; to: number }[]): Structure {
  return setLegProps(s, at, { gaps: gaps.length > 0 ? gaps : undefined });
}

// ─── Variation groups (docs/course-editor.md §12; 08 §5.3) ───────────

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The first label not in use: A … Z, then A2, B2 … */
function freeLabel(taken: ReadonlySet<string>): string {
  for (let round = 1; ; round += 1) {
    for (const l of LETTERS) {
      const label = round === 1 ? l : `${l}${round}`;
      if (!taken.has(label)) return label;
    }
  }
}

/** The first free group id `v1`, `v2` … */
function freeGroupId(s: Structure): string {
  const taken = new Set(s.items.flatMap((i) => (i.kind === "variation" ? [i.id] : [])));
  let n = 1;
  while (taken.has(`v${n}`)) n += 1;
  return `v${n}`;
}

function groupIndex(s: Structure, groupId: string): number {
  return s.items.findIndex((i) => i.kind === "variation" && i.id === groupId);
}

/**
 * Whether the leg into control-sequence position `at` (a leg phantom's
 * `insertAt`) can become a group: both its ends are top-level items with no
 * group between them (no nesting, 08 §4.3).
 */
export function canCreateGroup(s: Structure, at: number, kindOf: KindOf, orders?: GroupOrders): boolean {
  const p = pathOf(s, kindOf, orders);
  const t = p.first + at;
  const prev = p.paths[t - 1], next = p.paths[t];
  if (at < 0 || t > p.end || !prev || !next) return false;
  if (prev.alt || prev.anchorVisit || next.alt || next.anchorVisit) return false;
  return next.itemIndex === prev.itemIndex + 1;
}

/** *Create variation here* (§12): the leg into position `at` becomes a group with empty alternatives A and B (answer 5). */
export function createGroup(s: Structure, at: number, kindOf: KindOf, orders?: GroupOrders): { structure: Structure; groupId: string } | null {
  if (!canCreateGroup(s, at, kindOf, orders)) return null;
  const p = pathOf(s, kindOf, orders);
  const index = p.paths[p.first + at].itemIndex;
  const groupId = freeGroupId(s);
  const group: Group = { kind: "variation", id: groupId, alternatives: [{ label: "A", items: [] }, { label: "B", items: [] }] };
  const items = [...s.items];
  items.splice(index, 0, group);
  // The leg's props stay on its end item: they become the group's exit leg, every alternative's (the
  // item's predecessor changes from the anchor to the group, which would otherwise drop them).
  const out = edit(s, items);
  const end = s.items[index];
  const now = out.items[index + 1];
  if (end && end.kind !== "variation" && end.leg && now && now.kind !== "variation") {
    out.items[index + 1] = { ...now, leg: end.leg };
  }
  return { structure: out, groupId };
}

/** *Add alternative*: an empty one with the next free label. */
export function addAlternative(s: Structure, groupId: string): { structure: Structure; label: string } | null {
  const gi = groupIndex(s, groupId);
  const group = s.items[gi];
  if (!group || group.kind !== "variation") return null;
  const label = freeLabel(new Set(group.alternatives.map((a) => a.label)));
  const items = s.items.map((item, i) => (i === gi && item.kind === "variation" ? { ...item, alternatives: [...item.alternatives, { label, items: [] }] } : item));
  return { structure: edit(s, items), label };
}

/** Remove an alternative and its controls; with two left, the group dissolves into the other one's controls. */
export function removeAlternative(s: Structure, groupId: string, label: string): Structure {
  const gi = groupIndex(s, groupId);
  const group = s.items[gi];
  if (!group || group.kind !== "variation" || !group.alternatives.some((a) => a.label === label)) return s;
  const rest = group.alternatives.filter((a) => a.label !== label);
  const items = rest.length >= 2
    ? s.items.map((item, i) => (i === gi ? { ...group, alternatives: rest } : item))
    : [...s.items.slice(0, gi), ...rest[0].items, ...s.items.slice(gi + 1)];
  return edit(s, items);
}

/** Rename an alternative; a blank or taken label leaves the structure unchanged. */
export function renameAlternative(s: Structure, groupId: string, label: string, next: string): Structure {
  const name = next.trim();
  const gi = groupIndex(s, groupId);
  const group = s.items[gi];
  if (!name || name === label || !group || group.kind !== "variation" || group.alternatives.some((a) => a.label === name)) return s;
  return {
    ...s,
    items: s.items.map((item, i) => (i === gi ? { ...group, alternatives: group.alternatives.map((a) => (a.label === label ? { ...a, label: name } : a)) } : item)),
  };
}

/** The *Loop* checkbox: a butterfly returns to the anchor between its alternatives (08 §4.3). */
export function setLoop(s: Structure, groupId: string, loop: boolean): Structure {
  const gi = groupIndex(s, groupId);
  const group = s.items[gi];
  if (!group || group.kind !== "variation" || !!group.loop === loop) return s;
  const { loop: _l, ...rest } = group;
  return { ...s, items: s.items.map((item, i) => (i === gi ? (loop ? { ...rest, loop: true } : rest) : item)) };
}

/**
 * Drag a row into an alternative (§12): the visit at control-sequence
 * position `from` of the displayed path goes to the end of `label`'s
 * controls (an anchor visit does not move).
 */
export function moveToAlternative(s: Structure, from: number, groupId: string, label: string, kindOf: KindOf, orders?: GroupOrders): Structure {
  const p = pathOf(s, kindOf, orders);
  if (from < 0 || from >= p.end - p.first) return s;
  const out = withoutRow(s, p.paths[p.first + from]);
  const gi = groupIndex({ ...s, items: out?.items ?? [] }, groupId);
  if (!out || gi < 0) return s;
  const target = out.items[gi] as Group;
  if (!target.alternatives.some((a) => a.label === label)) return s;
  return edit(s, withAlternative(out.items, gi, label, (alt) => [...alt, out.item]));
}
