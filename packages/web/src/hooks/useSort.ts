import { useMemo, useCallback } from "react";
import { useSearchParams } from "react-router-dom";

export type SortDirection = "asc" | "desc";

export interface SortState<K extends string = string> {
  key: K;
  dir: SortDirection;
}

/**
 * Parse a URL sort param value like "name" or "-name" into a SortState.
 */
function parseSortParam<K extends string>(
  raw: string | null,
  defaultState: SortState<K>,
  validKeys: Set<K>,
): SortState<K> {
  if (!raw) return defaultState;
  const desc = raw.startsWith("-");
  const key = (desc ? raw.slice(1) : raw) as K;
  if (!validKeys.has(key)) return defaultState;
  return { key, dir: desc ? "desc" : "asc" };
}

/**
 * Serialize a SortState to URL param value: "key" for asc, "-key" for desc.
 * Returns empty string if it matches the default (so it gets removed from URL).
 */
function serializeSortParam<K extends string>(
  state: SortState<K>,
  defaultState: SortState<K>,
): string {
  if (state.key === defaultState.key && state.dir === defaultState.dir) return "";
  return state.dir === "desc" ? `-${state.key}` : state.key;
}

/**
 * Generic hook for client-side table sorting with URL persistence.
 *
 * Sort state is stored in the URL as `?sort=key` (asc) or `?sort=-key` (desc).
 * When the sort matches the default, the param is omitted from the URL.
 *
 * @param items   The array to sort
 * @param initial Default sort (key + direction)
 * @param comparators  Map of column keys to comparator functions.
 *                     Each comparator receives two items and returns a number (like Array.sort).
 *                     If omitted for a key, that column won't sort.
 */
export function useSort<T>(
  items: T[],
  initial: SortState<string>,
  comparators: Record<string, (a: T, b: T) => number>,
): {
  sorted: T[];
  sort: SortState<string>;
  toggle: (key: string) => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();

  const validKeys = useMemo(
    () => new Set(Object.keys(comparators)),
    [comparators],
  );

  const sort = useMemo(
    () => parseSortParam(searchParams.get("sort"), initial, validKeys),
    [searchParams, initial, validKeys],
  );

  const toggle = useCallback(
    (key: string) => {
      const next: SortState<string> =
        sort.key === key
          ? { key, dir: sort.dir === "asc" ? "desc" : "asc" }
          : { key, dir: "asc" };

      const serialized = serializeSortParam(next, initial);

      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (serialized) {
            p.set("sort", serialized);
          } else {
            p.delete("sort");
          }
          return p;
        },
        { replace: true },
      );
    },
    [sort, initial, setSearchParams],
  );

  const sorted = useMemo(() => {
    const cmp = comparators[sort.key];
    if (!cmp) return items;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...items].sort((a, b) => cmp(a, b) * dir);
  }, [items, sort, comparators]);

  return { sorted, sort, toggle };
}
