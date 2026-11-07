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

type Alternative = StoredVariationItem["alternatives"][number];

/** Every visiting order of a group: one alternative each, or (loop) every permutation. */
function groupOrders(group: StoredVariationItem): Alternative[][] {
  if (!group.loop) return group.alternatives.map((alt) => [alt]);
  const out: Alternative[][] = [];
  const permute = (rest: Alternative[], acc: Alternative[]) => {
    if (rest.length === 0) {
      out.push(acc);
      return;
    }
    rest.forEach((alt, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, alt]));
  };
  permute(group.alternatives, []);
  return out;
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

/** The anchor's repeated visit in a loop: the site, no role or leg, its hidden number kept. */
function anchorVisit(anchor: StoredControlItem): StoredControlItem {
  return anchor.numberHidden ? { siteId: anchor.siteId, numberHidden: true } : { siteId: anchor.siteId };
}

const copy = (item: StoredControlItem): StoredControlItem => structuredClone(item);

/** The concrete variants of a structure; `[]` for a structure without groups. */
export function materialiseVariants(s: StoredCourseStructure): MaterialisedVariant[] {
  if (!s.items.some((item) => item.kind === "variation")) return [];
  let partial: MaterialisedVariant[] = [{ key: "", items: [] }];
  s.items.forEach((item, index) => {
    if (item.kind !== "variation") {
      for (const p of partial) p.items.push(copy(item));
      return;
    }
    const prev = s.items[index - 1];
    const anchor = prev && prev.kind !== "variation" ? prev : undefined;
    const next: MaterialisedVariant[] = [];
    for (const p of partial) {
      for (const order of groupOrders(item)) {
        const items = [...p.items];
        let visited = false;
        for (const alt of order) {
          if (alt.items.length === 0) continue;
          if (item.loop && visited && anchor) items.push(anchorVisit(anchor));
          items.push(...alt.items.map(copy));
          visited = true;
        }
        next.push({ key: p.key + order.map((alt) => alt.label).join(""), items: items.map(copy) });
      }
    }
    partial = next;
  });
  return partial;
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
 * from every alternative, groups kept. A group then left without a non-empty
 * alternative, unanchored (first or last) or directly after another group
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
          items[i - 1].kind === "variation" ||
          item.alternatives.every((alt) => alt.items.length === 0)),
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
