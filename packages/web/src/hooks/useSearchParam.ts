import { useSearchParams } from "react-router-dom";
import { useCallback } from "react";

/**
 * Read a single search param, returning the value or a default.
 * The setter updates the URL without full navigation.
 */
export function useSearchParam(key: string, defaultValue = "") {
  const [searchParams, setSearchParams] = useSearchParams();
  const value = searchParams.get(key) ?? defaultValue;

  const setValue = useCallback(
    (next: string) => {
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next) {
            p.set(key, next);
          } else {
            p.delete(key);
          }
          return p;
        },
        { replace: true },
      );
    },
    [key, setSearchParams],
  );

  return [value, setValue] as const;
}

/**
 * Read a numeric search param, returning the number or undefined.
 */
export function useNumericSearchParam(key: string) {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(key);
  const value = raw ? parseInt(raw, 10) : undefined;
  const numValue = value && !isNaN(value) ? value : undefined;

  const setValue = useCallback(
    (next: number | undefined) => {
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next !== undefined) {
            p.set(key, String(next));
          } else {
            p.delete(key);
          }
          return p;
        },
        { replace: true },
      );
    },
    [key, setSearchParams],
  );

  return [numValue, setValue] as const;
}
