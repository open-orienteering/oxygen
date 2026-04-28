import type { Atom, FilterNode, OrGroup } from "./types";
import { isOrGroup } from "./types";

/**
 * Pure helpers used by `StructuredSearchBar` to mutate the root node list.
 * Kept pure (no React, no IDs) so they can be unit-tested without a DOM.
 */

/** ID generator for new nodes; replaceable in tests. */
export type IdGen = (prefix?: string) => string;

/**
 * Append a fresh atom into a list of root nodes, optionally folding it
 * into an OR group with a previous root.
 *
 * `target`:
 *   • `null`           — plain AND append at the end
 *   • `"auto"`         — fold with the immediately-previous root, creating
 *                        a new OR group if needed
 *   • `<existingId>`   — extend an existing OR group with that id (or
 *                        promote the matching root into one)
 */
export function appendAtom(
  roots: FilterNode[],
  atom: Atom,
  target: null | "auto" | string,
  newId: IdGen,
): FilterNode[] {
  if (target === null) {
    return [...roots, atom];
  }

  const next = [...roots];

  if (target === "auto") {
    if (next.length === 0) {
      next.push(atom);
      return next;
    }
    const lastIdx = next.length - 1;
    const last = next[lastIdx];
    if (isOrGroup(last) && !last.negated) {
      next[lastIdx] = { ...last, children: [...last.children, atom] };
      return next;
    }
    if (!isOrGroup(last)) {
      const group: OrGroup = {
        kind: "or",
        id: newId("og"),
        children: [last, atom],
      };
      next[lastIdx] = group;
      return next;
    }
    // Last is a negated group → fall back to a plain AND append.
    next.push(atom);
    return next;
  }

  // target is an existing node id
  const idx = next.findIndex((n) => n.id === target);
  if (idx < 0) {
    next.push(atom);
    return next;
  }
  const node = next[idx];
  if (isOrGroup(node)) {
    next[idx] = { ...node, children: [...node.children, atom] };
  } else {
    next[idx] = {
      kind: "or",
      id: newId("og"),
      children: [node, atom],
    };
  }
  return next;
}

/**
 * Remove a child atom from an OR group at the root level.
 * Auto-unwraps the group back to a plain atom when ≤1 child remains, and
 * drops the group entirely when no children remain.
 */
export function removeChildFromGroup(
  roots: FilterNode[],
  groupId: string,
  childId: string,
): FilterNode[] {
  return roots
    .map((n) => {
      if (!isOrGroup(n) || n.id !== groupId) return n;
      const remaining = n.children.filter((c) => c.id !== childId);
      if (remaining.length === 0) return null;
      if (remaining.length === 1) {
        const only = remaining[0];
        return n.negated ? { ...only, negated: !only.negated } : only;
      }
      return { ...n, children: remaining };
    })
    .filter((n): n is FilterNode => n !== null);
}

/**
 * Pop the last child of the trailing root node when the user hits
 * Backspace on an empty input.
 *   • Last root is an atom → drop the entire root
 *   • Last root is an OR group → pop its last child, auto-unwrap if needed
 */
export function popLastEntry(roots: FilterNode[]): FilterNode[] {
  if (roots.length === 0) return roots;
  const last = roots[roots.length - 1];
  if (!isOrGroup(last)) {
    return roots.slice(0, -1);
  }
  const remaining = last.children.slice(0, -1);
  const next = [...roots];
  if (remaining.length === 0) {
    next.pop();
  } else if (remaining.length === 1) {
    const only = remaining[0];
    next[next.length - 1] = last.negated
      ? { ...only, negated: !only.negated }
      : only;
  } else {
    next[next.length - 1] = { ...last, children: remaining };
  }
  return next;
}
