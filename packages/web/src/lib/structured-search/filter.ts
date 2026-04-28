import type {
  AnchorDef,
  Atom,
  FilterExpression,
  FilterNode,
} from "./types";
import { isOrGroup } from "./types";

/**
 * Apply a filter expression (or a flat node list) to a list of items.
 *
 * Semantics:
 *   • Root nodes are AND-ed together.
 *   • Inside an OR group, child atoms are OR-ed.
 *   • An atom or group with `negated: true` inverts its match result.
 *   • Free-text atoms (anchor === "") match against `freeTextFields` if
 *     supplied, otherwise against any string/number value on the item.
 *   • Tokens with an unknown anchor are non-filtering (preserves the
 *     historical behaviour).
 *
 * For backwards compatibility, the second argument may be either a
 * `FilterExpression` or a flat array of nodes / legacy `FilterToken`s.
 */
export function applyFilters<T>(
  items: T[],
  exprOrNodes: FilterExpression | FilterNode[],
  anchors: AnchorDef<T>[],
  freeTextFields?: (keyof T)[],
): T[] {
  const nodes: FilterNode[] = Array.isArray(exprOrNodes)
    ? exprOrNodes
    : exprOrNodes.roots;
  if (nodes.length === 0) return items;

  const anchorMap = new Map(anchors.map((a) => [a.key, a]));

  const matchAtom = (item: T, atom: Atom): boolean => {
    let raw: boolean;
    if (atom.anchor) {
      const anchor = anchorMap.get(atom.anchor);
      if (!anchor) {
        raw = true; // unknown anchor → don't filter (legacy behavior)
      } else {
        raw = anchor.match(item, atom.operator, atom.value);
      }
    } else {
      raw = matchFreeText(item, atom.value, freeTextFields);
    }
    return atom.negated ? !raw : raw;
  };

  const matchNode = (item: T, node: FilterNode): boolean => {
    if (isOrGroup(node)) {
      const any = node.children.some((c) => matchAtom(item, c));
      return node.negated ? !any : any;
    }
    return matchAtom(item, node);
  };

  return items.filter((item) => nodes.every((n) => matchNode(item, n)));
}

function matchFreeText<T>(
  item: T,
  query: string,
  fields?: (keyof T)[],
): boolean {
  const lowerQuery = query.toLowerCase();
  const obj = item as Record<string, unknown>;

  if (fields) {
    return fields.some((f) => {
      const val = obj[f as string];
      if (typeof val === "string") return val.toLowerCase().includes(lowerQuery);
      if (typeof val === "number") return String(val).includes(query);
      return false;
    });
  }

  return Object.values(obj).some((val) => {
    if (typeof val === "string") return val.toLowerCase().includes(lowerQuery);
    if (typeof val === "number") return String(val).includes(query);
    return false;
  });
}
