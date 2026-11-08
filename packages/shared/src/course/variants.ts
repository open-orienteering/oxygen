/**
 * Variants of a course with variation groups (docs/course-layer.md §12;
 * research 08 §4.3 "Materialisation").
 *
 * A structure's variants are the cartesian product over its groups, in item
 * order: a plain group contributes one alternative at a time, a `loop`
 * group (butterfly) every visiting order of its alternatives. A group's key
 * is its alternatives' labels in visiting order (`"A"`, `"BA"`), the
 * course's key the groups' keys concatenated (`"AC"`, `"ABA"`). A variant
 * is a linear structure (no groups) — the v1 shape every consumer reads —
 * so the layer, print, lengths and export need nothing for variants.
 *
 * Loops return to the anchor (the control before the group): between two
 * consecutive non-empty alternatives the anchor is visited again; the visit
 * after the last alternative is the structure's own next item. An empty
 * alternative (answer 5) contributes nothing: a straight leg.
 *
 * Pure: no ids are resolved and nothing is validated beyond the schema.
 */

import type { StoredControlItem, StoredCourseStructure, StoredVariationItem } from "./structure.js";

/** Variants beyond this many are refused by `course.setStructure` (`VARIANT_LIMIT`). */
export const MAX_VARIANTS = 100;

export interface MaterialisedVariant {
  /** `"AC"`, `"BA"`: the groups' keys in item order. */
  key: string;
  /** The variant's control items, in visiting order. */
  items: StoredControlItem[];
}

function factorial(n: number): number {
  let f = 1;
  for (let i = 2; i <= n; i += 1) f *= i;
  return f;
}

/** How many variants `materialiseVariants` yields, without building them; 0 without groups. */
export function variantCount(s: StoredCourseStructure): number {
  let n = 0;
  for (const item of s.items) {
    if (item.kind !== "variation") continue;
    const k = item.loop ? factorial(item.alternatives.length) : item.alternatives.length;
    n = n === 0 ? k : n * k;
  }
  return n;
}

/**
 * The visiting order of each group's alternatives, by group id: one label
 * for a plain group, every label once for a loop (course-editor.md §12). A
 * group missing from the record is visited by its first alternative (a
 * loop: every alternative in stored order); unknown labels are skipped.
 */
export type GroupOrders = Readonly<Record<string, readonly string[]>>;

/**
 * Where a path row comes from in its structure (course-editor.md §12): a
 * top-level item, the `index`-th item of a group's alternative, or a loop's
 * repeated anchor visit (no item of its own; `itemIndex` is the group's).
 */
export type RowPath =
  | { itemIndex: number; alt?: undefined; anchorVisit?: undefined }
  | { itemIndex: number; alt: { label: string; index: number }; anchorVisit?: undefined }
  | { itemIndex: number; alt?: undefined; anchorVisit: true };

/** What a path reads of a control item, whatever the site-id type. */
interface PathControl {
  kind?: "control";
  siteId: string | number;
  numberHidden?: boolean;
}
/** What a path reads of a group, whatever the site-id type. */
export interface PathGroup<C> {
  kind: "variation";
  id: string;
  alternatives: { label: string; items: C[] }[];
  loop?: boolean;
}
interface PathStructure<C> {
  items: readonly (C | PathGroup<C>)[];
}

/** A group's alternatives in their visiting order under `orders`: the ones named, else the first (a loop: all, stored order). */
export function groupOrder<C>(group: PathGroup<C>, orders: GroupOrders | undefined): PathGroup<C>["alternatives"] {
  const named = orders?.[group.id];
  if (named) {
    const out = named.flatMap((label) => group.alternatives.filter((a) => a.label === label));
    if (out.length > 0) return out;
  }
  return group.loop ? group.alternatives : group.alternatives.slice(0, 1);
}

/** The anchor's repeated visit in a loop: the site, no role or leg, its hidden number kept. */
function anchorVisit<C extends PathControl>(anchor: C): C {
  return (anchor.numberHidden ? { siteId: anchor.siteId, numberHidden: true } : { siteId: anchor.siteId }) as C;
}

const copy = <C,>(item: C): C => structuredClone(item);

/**
 * One path through a structure (course-editor.md §12): every group visited
 * in the order `orders` names — the displayed alternatives in Course view,
 * a variant's orders in Variant view — with a loop's anchor visit between
 * consecutive non-empty alternatives, exactly as a variant is materialised.
 * `paths[i]` says where `items[i]` comes from. Items are copies.
 */
export function pathOfOrders<C extends PathControl>(s: PathStructure<C>, orders?: GroupOrders): { items: C[]; paths: RowPath[] } {
  const items: C[] = [];
  const paths: RowPath[] = [];
  s.items.forEach((item, itemIndex) => {
    if (item.kind !== "variation") {
      items.push(copy(item as C));
      paths.push({ itemIndex });
      return;
    }
    const group = item as PathGroup<C>;
    const prev = s.items[itemIndex - 1];
    const anchor = prev && prev.kind !== "variation" ? (prev as C) : undefined;
    let visited = false;
    for (const alt of groupOrder(group, orders)) {
      if (alt.items.length === 0) continue;
      if (group.loop && visited && anchor) {
        items.push(anchorVisit(anchor));
        paths.push({ itemIndex, anchorVisit: true });
      }
      alt.items.forEach((c, index) => {
        items.push(copy(c));
        paths.push({ itemIndex, alt: { label: alt.label, index } });
      });
      visited = true;
    }
  });
  return { items, paths };
}

/** The leg props a path item may carry (only `style` is read here). */
interface LeggedControl extends PathControl {
  leg?: { style?: string } & Record<string, unknown>;
}

/**
 * All variations (course-layer.md §12.7): the **spine** — the top-level
 * items, the leg across a plain group `style: "none"` (its branches draw
 * it; a loop keeps the anchor → next leg) — and one **branch** per
 * alternative: the anchor (a visit only), the alternative's controls, then
 * the next item (a loop's petal returns to the anchor instead). An empty
 * plain alternative is the straight leg anchor → next; an empty petal is
 * no branch. A group without a control on both sides draws no branch.
 * The editor's screen view tints the branches (F7); the all-variations
 * print draws them in the one purple (F8). Items are copies.
 */
export function allVariationStructures<C extends LeggedControl>(s: PathStructure<C>): { spine: C[]; branches: { groupId: string; label: string; items: C[] }[] } {
  const spine: C[] = [];
  const branches: { groupId: string; label: string; items: C[] }[] = [];
  s.items.forEach((item, i) => {
    if (item.kind !== "variation") {
      const prev = s.items[i - 1] as C | PathGroup<C> | undefined;
      const c = copy(item as C);
      spine.push(prev?.kind === "variation" && !prev.loop ? ({ ...c, leg: { ...(c.leg ?? {}), style: "none" } } as C) : c);
      return;
    }
    const group = item as PathGroup<C>;
    const anchor = s.items[i - 1];
    const next = s.items[i + 1];
    if (!anchor || anchor.kind === "variation" || !next || next.kind === "variation") return;
    const visit = () => ({ siteId: (anchor as C).siteId }) as C;
    for (const alt of group.alternatives) {
      if (group.loop && alt.items.length === 0) continue;
      branches.push({ groupId: group.id, label: alt.label, items: [visit(), ...alt.items.map(copy), group.loop ? visit() : copy(next as C)] });
    }
  });
  return { spine, branches };
}

/** Every visiting order of a group's labels: one alternative each, or (loop) every permutation. */
function labelOrders(group: { alternatives: readonly { label: string }[]; loop?: boolean }): string[][] {
  const labels = group.alternatives.map((alt) => alt.label);
  if (!group.loop) return labels.map((label) => [label]);
  const out: string[][] = [];
  const permute = (rest: string[], acc: string[]) => {
    if (rest.length === 0) {
      out.push(acc);
      return;
    }
    rest.forEach((label, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, label]));
  };
  permute(labels, []);
  return out;
}

type OrderItem = { kind?: "control" | "variation"; id?: string; alternatives?: readonly { label: string }[]; loop?: boolean };

/**
 * Every variant's key and its groups' visiting orders, in
 * `materialiseVariants`' order (the cartesian product over groups in item
 * order); `[]` without groups. `pathOfOrders(s, orders)` is that variant.
 */
export function variantOrders(s: { items: readonly OrderItem[] }): { key: string; orders: Record<string, string[]> }[] {
  const groups = s.items.filter((item) => item.kind === "variation");
  if (groups.length === 0) return [];
  let partial: { key: string; orders: Record<string, string[]> }[] = [{ key: "", orders: {} }];
  for (const group of groups) {
    const next: typeof partial = [];
    for (const p of partial) {
      for (const order of labelOrders({ alternatives: group.alternatives ?? [], loop: group.loop })) {
        next.push({ key: p.key + order.join(""), orders: { ...p.orders, [group.id ?? ""]: order } });
      }
    }
    partial = next;
  }
  return partial;
}

/** The concrete variants of a structure; `[]` for a structure without groups. */
export function materialiseVariants(s: StoredCourseStructure): MaterialisedVariant[] {
  return variantOrders(s).map(({ key, orders }) => ({ key, items: pathOfOrders<StoredControlItem>(s, orders).items }));
}

/** One variant as a linear structure (the column's shape, no groups); null for an unknown key. */
export function variantStructure(s: StoredCourseStructure, key: string): StoredCourseStructure | null {
  const v = materialiseVariants(s).find((x) => x.key === key);
  if (!v) return null;
  return { version: 1, id: s.id, orderMode: s.orderMode, items: v.items };
}

/** Keys that occur more than once (multi-letter labels can collide), sorted. */
export function variantKeyDuplicates(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const k of keys) (seen.has(k) ? dup : seen).add(k);
  return [...dup].sort();
}

/** Every site a structure visits, in any alternative, once each in first-seen order. */
export function structureSiteIds(s: StoredCourseStructure): string[] {
  const out = new Set<string>();
  const crossings: string[] = [];
  const visit = (c: StoredControlItem) => {
    out.add(c.siteId);
    if (c.leg?.crossing) crossings.push(c.leg.crossing.controlId);
  };
  for (const item of s.items) {
    if (item.kind === "variation") for (const alt of item.alternatives) for (const c of alt.items) visit(c);
    else visit(item);
  }
  // The crossing points the legs run through (course-layer.md §10.3), after the items.
  for (const id of crossings) out.add(id);
  return [...out];
}

type Offsets = Record<string, { dx: number; dy: number }>;

/**
 * Remove a site from a structure (a deleted control): from the top level and
 * from every alternative, groups kept — one left with every alternative
 * empty too (valid since F7: straight legs until controls land). A group
 * left unanchored (first or last) or directly after another group
 * dissolves into its first alternative's items, so the result passes the
 * schema whenever the input did. The site's label offset goes too.
 */
export function pruneSiteFromStructure<T extends StoredCourseStructure & { labelOffsets?: Offsets }>(s: T, siteId: string): T {
  // A leg that ran through the site (a crossing point, §10.3) loses its `crossing`; an empty leg goes.
  const unroute = <C extends StoredControlItem>(c: C): C => {
    if (c.leg?.crossing?.controlId !== siteId) return c;
    const { crossing: _gone, ...leg } = c.leg;
    const { leg: _leg, ...rest } = c;
    return (Object.keys(leg).length > 0 ? { ...rest, leg } : rest) as C;
  };
  let items: StoredCourseStructure["items"] = s.items
    .filter((item) => item.kind === "variation" || item.siteId !== siteId)
    .map((item) =>
      item.kind === "variation"
        ? { ...item, alternatives: item.alternatives.map((alt) => ({ ...alt, items: alt.items.filter((c) => c.siteId !== siteId).map(unroute) })) }
        : unroute(item),
    );
  for (;;) {
    const bad = items.findIndex(
      (item, i) =>
        item.kind === "variation" &&
        (i === 0 ||
          i === items.length - 1 ||
          items[i - 1].kind === "variation"),
    );
    if (bad < 0) break;
    const group = items[bad] as StoredVariationItem;
    items = [...items.slice(0, bad), ...group.alternatives[0].items, ...items.slice(bad + 1)];
  }
  const out = { ...s, items };
  if (s.labelOffsets && siteId in s.labelOffsets) {
    const { [siteId]: _gone, ...rest } = s.labelOffsets;
    out.labelOffsets = rest;
  }
  return out;
}
