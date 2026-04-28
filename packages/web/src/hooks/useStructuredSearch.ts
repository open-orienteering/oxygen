import { useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import type {
  AnchorDef,
  Atom,
  FilterExpression,
  FilterNode,
} from "../lib/structured-search/types";
import { isOrGroup } from "../lib/structured-search/types";
import {
  parseExpression,
  serializeExpression,
} from "../lib/structured-search/parser";
import { applyFilters } from "../lib/structured-search/filter";

/**
 * Hook that manages structured search state synced to the URL `?q=` param.
 *
 * Returns the parsed expression as a flat list of root nodes (`tokens`)
 * along with helpers. OR groups appear as nodes alongside atoms — page
 * code that only inspects atoms can use the type guards in
 * `lib/structured-search/types`.
 */
export function useStructuredSearch<T>(
  anchors: AnchorDef<T>[],
  freeTextFields?: (keyof T)[],
) {
  const [searchParams, setSearchParams] = useSearchParams();
  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;

  const expression = useMemo<FilterExpression>(() => {
    const q = searchParams.get("q") ?? "";
    return parseExpression(q, anchors as AnchorDef<never>[]);
  }, [searchParams.get("q"), anchors]);

  // Flat list of root nodes — what the bar and pages render directly.
  const tokens = expression.roots;

  const setExpression = useCallback(
    (next: FilterExpression) => {
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          const serialized = serializeExpression(next);
          if (serialized) {
            p.set("q", serialized);
          } else {
            p.delete("q");
          }
          // Clean up legacy params, if any
          p.delete("search");
          p.delete("class");
          p.delete("club");
          p.delete("status");
          return p;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setTokens = useCallback(
    (newTokens: FilterNode[]) => {
      setExpression({ roots: newTokens });
    },
    [setExpression],
  );

  /**
   * Set a single root-level atom for a given anchor key. Replaces any
   * existing root atom (or root OR group containing only that anchor)
   * for the same key. Does not touch OR groups that mix multiple
   * anchors — those keep their existing semantics.
   */
  const setAnchorValue = useCallback(
    (anchorKey: string, value: string | undefined) => {
      const currentQ = searchParams.get("q") ?? "";
      const currentExpr = parseExpression(
        currentQ,
        anchorsRef.current as AnchorDef<never>[],
      );

      const filtered: FilterNode[] = currentExpr.roots.filter((node) => {
        if (isOrGroup(node)) return true;
        return node.anchor !== anchorKey;
      });

      if (value) {
        const anchor = anchorsRef.current.find((a) => a.key === anchorKey);
        if (anchor) {
          const atom: Atom = {
            kind: "atom",
            id: `sa_${Date.now()}`,
            anchor: anchorKey,
            operator: anchor.defaultOperator,
            value,
          };
          filtered.push(atom);
        }
      }

      setExpression({ roots: filtered });
    },
    [searchParams, setExpression],
  );

  /** Get the first root-level atom value for the given anchor key, if any. */
  const getAnchorValue = useCallback(
    (anchorKey: string): string | undefined => {
      for (const node of expression.roots) {
        if (isOrGroup(node)) continue;
        if (node.anchor === anchorKey) return node.value;
      }
      return undefined;
    },
    [expression],
  );

  const filterItems = useCallback(
    (items: T[]): T[] => {
      return applyFilters(items, expression, anchorsRef.current, freeTextFields);
    },
    [expression, freeTextFields],
  );

  return {
    expression,
    setExpression,
    tokens,
    setTokens,
    setAnchorValue,
    getAnchorValue,
    filterItems,
  };
}
