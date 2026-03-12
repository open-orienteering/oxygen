import { useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import type { AnchorDef, FilterToken } from "../lib/structured-search/types";
import { parseQuery, serializeTokens } from "../lib/structured-search/parser";
import { applyFilters } from "../lib/structured-search/filter";

/**
 * Hook that manages structured search state synced to URL ?q= param.
 * Returns tokens, setters, and a filterItems function.
 */
export function useStructuredSearch<T>(
  anchors: AnchorDef<T>[],
  freeTextFields?: (keyof T)[],
) {
  const [searchParams, setSearchParams] = useSearchParams();
  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;

  // Parse tokens from URL
  const tokens = useMemo(() => {
    const q = searchParams.get("q") ?? "";
    return parseQuery(q, anchors as AnchorDef<never>[]);
  }, [searchParams.get("q"), anchors]);

  // Update URL when tokens change
  const setTokens = useCallback(
    (newTokens: FilterToken[]) => {
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          const serialized = serializeTokens(newTokens);
          if (serialized) {
            p.set("q", serialized);
          } else {
            p.delete("q");
          }
          // Clean up old params if migrating
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

  // Add or replace a token for a specific anchor
  const setAnchorValue = useCallback(
    (anchorKey: string, value: string | undefined) => {
      const currentQ = searchParams.get("q") ?? "";
      const currentTokens = parseQuery(currentQ, anchorsRef.current as AnchorDef<never>[]);

      // Remove existing tokens for this anchor
      const filtered = currentTokens.filter((t) => t.anchor !== anchorKey);

      if (value) {
        const anchor = anchorsRef.current.find((a) => a.key === anchorKey);
        if (anchor) {
          filtered.push({
            id: `sa_${Date.now()}`,
            anchor: anchorKey,
            operator: anchor.defaultOperator,
            value,
          });
        }
      }

      setTokens(filtered);
    },
    [searchParams, setTokens],
  );

  // Get the current value for a specific anchor (first match)
  const getAnchorValue = useCallback(
    (anchorKey: string): string | undefined => {
      return tokens.find((t) => t.anchor === anchorKey)?.value;
    },
    [tokens],
  );

  // Filter items using current tokens
  const filterItems = useCallback(
    (items: T[]): T[] => {
      return applyFilters(items, tokens, anchorsRef.current, freeTextFields);
    },
    [tokens, freeTextFields],
  );

  return {
    tokens,
    setTokens,
    setAnchorValue,
    getAnchorValue,
    filterItems,
  };
}
