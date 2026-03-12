import type { AnchorDef, FilterToken, FilterOperator } from "./types";

let nextId = 0;
function uid(): string {
  return `ft_${++nextId}`;
}

/** Reset the ID counter (for tests) */
export function resetIdCounter(): void {
  nextId = 0;
}

/**
 * Tokenize a raw query string into segments, respecting quoted strings.
 * e.g. `class:H21 name:"Anna Svensson" ok` → ["class:H21", 'name:"Anna Svensson"', "ok"]
 */
function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
    } else if (ch === " " && !inQuote) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Detect the operator from a raw value string.
 * Returns [operator, cleanValue].
 */
function detectOperator(
  rawValue: string,
  defaultOp: FilterOperator,
): [FilterOperator, string] {
  // Order matters: check >= and <= before > and <
  if (rawValue.startsWith(">=")) return ["gte", rawValue.slice(2)];
  if (rawValue.startsWith("<=")) return ["lte", rawValue.slice(2)];
  if (rawValue.startsWith(">")) return ["gt", rawValue.slice(1)];
  if (rawValue.startsWith("<")) return ["lt", rawValue.slice(1)];
  if (rawValue.includes(",")) return ["in", rawValue];
  if (rawValue.includes("*")) return ["wildcard", rawValue];
  return [defaultOp, rawValue];
}

/**
 * Strip surrounding quotes from a value.
 */
function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse a raw query string into structured FilterTokens.
 */
export function parseQuery(
  raw: string,
  anchors: AnchorDef<never>[],
): FilterToken[] {
  if (!raw.trim()) return [];

  const anchorMap = new Map(anchors.map((a) => [a.key.toLowerCase(), a]));
  const segments = tokenize(raw.trim());

  return segments.map((segment) => {
    const colonIdx = segment.indexOf(":");
    if (colonIdx > 0) {
      const anchorKey = segment.slice(0, colonIdx).toLowerCase();
      const anchor = anchorMap.get(anchorKey);
      if (anchor) {
        const rawValue = unquote(segment.slice(colonIdx + 1));
        const [operator, value] = detectOperator(
          rawValue,
          anchor.defaultOperator,
        );
        return { id: uid(), anchor: anchor.key, operator, value };
      }
    }
    // Free text token
    return {
      id: uid(),
      anchor: "",
      operator: "contains" as FilterOperator,
      value: unquote(segment),
    };
  });
}

/**
 * Serialize FilterTokens back into a query string.
 */
export function serializeTokens(tokens: FilterToken[]): string {
  return tokens
    .map((t) => {
      const value = serializeValue(t);
      const needsQuote = value.includes(" ");
      const quotedValue = needsQuote ? `"${value}"` : value;
      if (!t.anchor) return quotedValue;
      return `${t.anchor}:${quotedValue}`;
    })
    .join(" ");
}

function serializeValue(token: FilterToken): string {
  const { operator, value } = token;
  switch (operator) {
    case "gt":
      return `>${value}`;
    case "lt":
      return `<${value}`;
    case "gte":
      return `>=${value}`;
    case "lte":
      return `<=${value}`;
    default:
      return value;
  }
}
