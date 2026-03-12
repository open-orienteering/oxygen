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

/** A single parsed filter token */
export interface FilterToken {
  id: string;
  /** Field key, e.g. "class", "status". Empty string for free text. */
  anchor: string;
  operator: FilterOperator;
  /** Raw value string, e.g. "H21", "<25", "si8,siac" */
  value: string;
}

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
