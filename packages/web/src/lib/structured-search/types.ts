/** Comparison operators for structured search filters */
export type FilterOperator =
  | "eq"
  | "contains"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "wildcard"
  | "in";

/**
 * A leaf filter — a single anchor:value comparison or free-text fragment.
 * `kind` is optional so legacy `FilterToken[]` callers (where kind was
 * implicit) keep working: anything without `kind: "or"` is treated as an atom.
 */
export interface Atom {
  kind?: "atom";
  id: string;
  /** Field key, e.g. "class", "status". Empty string for free text. */
  anchor: string;
  operator: FilterOperator;
  /** Raw value string, e.g. "H21", "<25", "si8,siac" */
  value: string;
  /** When true, the atom's match result is inverted. */
  negated?: boolean;
}

/**
 * A one-level OR-grouping of atoms. Children are ORed; the group is
 * AND-ed with its siblings at the root.
 *
 * Depth-1 by design: groups never contain other groups in the UI.
 * The parser flattens any deeper nesting that arrives via the URL.
 */
export interface OrGroup {
  kind: "or";
  id: string;
  children: Atom[];
  /** When true, the entire OR result is inverted (NOT (a OR b ...)). */
  negated?: boolean;
}

/** A node at the root level — either an atom or an OR group. */
export type FilterNode = Atom | OrGroup;

/**
 * The full parsed query: a flat list of nodes, ANDed together at the root.
 * Use this when the caller cares about OR groups; otherwise the legacy
 * `Atom[]` / `FilterToken[]` shape is still accepted by `applyFilters`.
 */
export interface FilterExpression {
  roots: FilterNode[];
}

/** @deprecated Alias kept for incremental migration. Equivalent to `Atom`. */
export type FilterToken = Atom;

/** Suggestion item shown in the autocomplete dropdown */
export interface SuggestionItem {
  key: string;
  label: string;
  description?: string;
}

/** Defines a searchable field (anchor) for a specific page */
export interface AnchorDef<T = unknown> {
  /** Anchor key used in query syntax, e.g. "class" */
  key: string;
  /** Display label (translated at render time) */
  label: string;
  /** Data type for operator inference */
  type: "string" | "number" | "enum";
  /** Allowed operators */
  operators: FilterOperator[];
  /** Default operator when none is specified */
  defaultOperator: FilterOperator;
  /** Tailwind color token for pill styling, e.g. "purple" */
  color: string;
  /** Optional value suggestion function */
  suggest?: (query: string, data: unknown) => SuggestionItem[];
  /** Client-side filter predicate */
  match: (item: T, op: FilterOperator, value: string) => boolean;
}

/** Type guard: true when a node is an OrGroup. */
export function isOrGroup(node: FilterNode): node is OrGroup {
  return (node as OrGroup).kind === "or";
}

/** Type guard: true when a node is an Atom (anything not an OrGroup). */
export function isAtom(node: FilterNode): node is Atom {
  return !isOrGroup(node);
}
