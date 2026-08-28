import type {
  AnchorDef,
  Atom,
  FilterExpression,
  FilterNode,
  FilterOperator,
  FilterToken,
  OrGroup,
} from "./types";
import { isOrGroup } from "./types";

let nextId = 0;
function uid(prefix = "ft"): string {
  return `${prefix}_${++nextId}`;
}

/** Reset the ID counter (for tests) */
export function resetIdCounter(): void {
  nextId = 0;
}

// ─── Lexer ─────────────────────────────────────────────────────────────

type LexToken =
  | { kind: "segment"; value: string }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "or" }
  | { kind: "and" };

/**
 * Tokenize a raw query string into a stream of structural tokens. Quotes
 * are honoured so values like `name:"a|b"` stay intact. Outside of quotes,
 * the punctuation `(`, `)`, `|`, `&` and whitespace are structural and
 * separate adjacent segments. Inside an `anchor:` segment we additionally
 * collect the value half until we hit unquoted whitespace or punctuation.
 */
function lex(raw: string): LexToken[] {
  const out: LexToken[] = [];
  let cur = "";
  let inQuote = false;

  const flush = () => {
    if (cur) {
      out.push({ kind: "segment", value: cur });
      cur = "";
    }
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      inQuote = !inQuote;
      cur += ch;
      continue;
    }
    if (inQuote) {
      cur += ch;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      flush();
      continue;
    }
    if (ch === "(") {
      flush();
      out.push({ kind: "lparen" });
      continue;
    }
    if (ch === ")") {
      flush();
      out.push({ kind: "rparen" });
      continue;
    }
    if (ch === "|") {
      flush();
      out.push({ kind: "or" });
      continue;
    }
    if (ch === "&") {
      flush();
      out.push({ kind: "and" });
      continue;
    }
    cur += ch;
  }
  flush();
  return out;
}

// ─── Atom-level helpers (operator detection, quoting) ──────────────────

/**
 * True when the whole value is wrapped in exactly one pair of double
 * quotes. `"a","b"` is deliberately excluded — that is a list of two
 * quoted items, not one quoted value.
 */
function isFullyQuoted(value: string): boolean {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    return false;
  }
  return !value.slice(1, -1).includes('"');
}

function unquote(value: string): string {
  return isFullyQuoted(value) ? value.slice(1, -1) : value;
}

/** True when the value contains a comma outside of any quoted run. */
function hasTopLevelComma(value: string): boolean {
  let inQuote = false;
  for (const ch of value) {
    if (ch === '"') inQuote = !inQuote;
    else if (ch === "," && !inQuote) return true;
  }
  return false;
}

/**
 * Split an `in` list on its top-level commas and unquote each item, so
 * `"Öppen 1","Öppen 2"` becomes `["Öppen 1", "Öppen 2"]`. Items may not
 * themselves contain a comma — quote an item to keep spaces, not commas.
 */
function splitList(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (const ch of value) {
    if (ch === '"') {
      inQuote = !inQuote;
      cur += ch;
    } else if (ch === "," && !inQuote) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((item) => unquote(item.trim())).filter(Boolean);
}

const RANGE_PREFIXES: [string, FilterOperator][] = [
  [">=", "gte"],
  ["<=", "lte"],
  [">", "gt"],
  ["<", "lt"],
];

/**
 * Infer the comparison operator from a raw (still-quoted) value.
 *
 * Two rules keep inference from hijacking legitimate values:
 *
 *  • Quoting means "take this literally". A fully quoted value never
 *    infers an operator from its own content, so the Eventor name format
 *    `name:"Kempe, Hugo"` stays a single substring search instead of
 *    being split into the `in` list `kempe` / `hugo`. Only commas
 *    *outside* quotes separate list items.
 *  • An operator is only inferred when the anchor declares support for
 *    it. `name` allows ["contains", "wildcard"], so a comma can never
 *    turn it into an `in` and a `>` prefix stays part of the value.
 */
function detectOperator(
  rawValue: string,
  anchor: Pick<AnchorDef<never>, "operators" | "defaultOperator">,
): [FilterOperator, string] {
  const { operators, defaultOperator } = anchor;

  if (hasTopLevelComma(rawValue) && operators.includes("in")) {
    return ["in", splitList(rawValue).join(",")];
  }

  if (isFullyQuoted(rawValue)) return [defaultOperator, unquote(rawValue)];

  for (const [prefix, op] of RANGE_PREFIXES) {
    if (rawValue.startsWith(prefix)) {
      return operators.includes(op)
        ? [op, rawValue.slice(prefix.length)]
        : [defaultOperator, rawValue];
    }
  }

  if (rawValue.includes("*") && operators.includes("wildcard")) {
    return ["wildcard", rawValue];
  }

  return [defaultOperator, unquote(rawValue)];
}

/**
 * Convert a raw segment (already stripped of `!` prefix) into an Atom.
 * Returns null for empty input.
 */
function segmentToAtom(
  segment: string,
  anchorMap: Map<string, AnchorDef<never>>,
): Atom | null {
  if (!segment) return null;

  const colonIdx = segment.indexOf(":");
  if (colonIdx > 0) {
    const anchorKey = segment.slice(0, colonIdx).toLowerCase();
    const anchor = anchorMap.get(anchorKey);
    if (anchor) {
      const rawValue = segment.slice(colonIdx + 1);
      if (!rawValue) return null;
      const [operator, value] = detectOperator(rawValue, anchor);
      if (!value) return null;
      return {
        kind: "atom",
        id: uid(),
        anchor: anchor.key,
        operator,
        value,
      };
    }
  }
  return {
    kind: "atom",
    id: uid(),
    anchor: "",
    operator: "contains",
    value: unquote(segment),
  };
}

/**
 * Parse a single `anchor:value` (or free-text) segment into an Atom.
 *
 * Exported so the search bar's live input and a `?q=` deep link agree on
 * operator inference and quoting — they used to carry separate copies of
 * these rules and drift apart.
 */
export function parseSegment(
  raw: string,
  anchors: AnchorDef<never>[],
): Atom | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return segmentToAtom(
    trimmed,
    new Map(anchors.map((a) => [a.key.toLowerCase(), a])),
  );
}

// ─── Parser ────────────────────────────────────────────────────────────

interface ParserState {
  tokens: LexToken[];
  pos: number;
  anchorMap: Map<string, AnchorDef<never>>;
}

function peek(s: ParserState, offset = 0): LexToken | undefined {
  return s.tokens[s.pos + offset];
}

function consume(s: ParserState): LexToken | undefined {
  return s.tokens[s.pos++];
}

/** Parse one Atom, optionally with a leading `!` for negation. */
function parseAtom(s: ParserState): Atom | null {
  let negated = false;
  let seg = peek(s);
  if (seg?.kind === "segment" && seg.value === "!") {
    negated = true;
    s.pos++;
    seg = peek(s);
  } else if (seg?.kind === "segment" && seg.value.startsWith("!")) {
    negated = true;
    s.pos++;
    const stripped = seg.value.slice(1);
    if (!stripped) {
      // Bare "!" with nothing attached — treat as a no-op
      return null;
    }
    const atom = segmentToAtom(stripped, s.anchorMap);
    if (!atom) return null;
    if (negated) atom.negated = true;
    return atom;
  }
  if (!seg || seg.kind !== "segment") return null;
  consume(s);
  const atom = segmentToAtom(seg.value, s.anchorMap);
  if (!atom) return null;
  if (negated) atom.negated = true;
  return atom;
}

/**
 * Parse the body inside a `(...)`. Inside parens we always produce one
 * OR group — any AND children are flattened into siblings of the OR
 * (depth-1 invariant: groups never nest), and any nested groups are
 * inlined.
 */
function parseParenBody(s: ParserState, negated: boolean): OrGroup {
  const children: Atom[] = [];

  const addNode = (node: FilterNode | null) => {
    if (!node) return;
    if (isOrGroup(node)) {
      // Flatten nested OR group
      const innerNeg = node.negated ?? false;
      for (const c of node.children) {
        children.push(innerNeg ? { ...c, negated: !c.negated } : c);
      }
    } else {
      children.push(node);
    }
  };

  while (true) {
    const t = peek(s);
    if (!t || t.kind === "rparen") break;
    if (t.kind === "or" || t.kind === "and") {
      consume(s);
      continue;
    }
    if (t.kind === "lparen") {
      consume(s);
      // Nested `(!(...))` is not currently produced by the UI; a leading
      // `!` before `(` at the root level is handled in `parseElement`.
      addNode(parseParenBody(s, false));
      const close = peek(s);
      if (close?.kind === "rparen") consume(s);
      continue;
    }
    const atom = parseAtom(s);
    if (atom) addNode(atom);
  }

  return {
    kind: "or",
    id: uid("og"),
    children,
    negated,
  };
}

/**
 * Parse one root-level "element": either an atom (possibly negated) or a
 * parenthesised group (possibly negated).
 */
function parseElement(s: ParserState): FilterNode | null {
  let negated = false;
  // Leading `!` as its own segment, or `!(...)`
  const head = peek(s);
  if (head?.kind === "segment" && head.value === "!") {
    negated = true;
    consume(s);
  }
  const after = peek(s);
  if (after?.kind === "lparen") {
    consume(s);
    const group = parseParenBody(s, negated);
    const close = peek(s);
    if (close?.kind === "rparen") consume(s);
    // Single-child group → unwrap to plain atom (with negation propagated)
    if (group.children.length === 1) {
      const only = group.children[0];
      if (negated) {
        return { ...only, negated: !only.negated };
      }
      return only;
    }
    if (group.children.length === 0) return null;
    return group;
  }
  // Otherwise it's an atom — feed back the `!` we may have consumed
  if (negated) {
    // Re-inject negation on the atom we're about to read
    const atom = parseAtom(s);
    if (!atom) return null;
    atom.negated = !atom.negated;
    return atom;
  }
  return parseAtom(s);
}

/**
 * Top-level parser. Walks the lex stream and folds `|`-joined neighbours
 * into depth-1 OR groups; everything else AND-joins.
 */
function parseRoot(s: ParserState): FilterNode[] {
  const roots: FilterNode[] = [];
  let pendingOr = false;

  while (true) {
    const t = peek(s);
    if (!t) break;
    if (t.kind === "rparen") {
      // Stray ) — skip
      consume(s);
      continue;
    }
    if (t.kind === "or") {
      consume(s);
      pendingOr = true;
      continue;
    }
    if (t.kind === "and") {
      consume(s);
      pendingOr = false;
      continue;
    }
    const node = parseElement(s);
    if (!node) continue;

    if (pendingOr && roots.length > 0) {
      // Fold this node into the previous root as an OR sibling.
      const prev = roots[roots.length - 1];
      if (isOrGroup(prev) && !prev.negated) {
        // Extend existing group
        if (isOrGroup(node)) {
          for (const c of node.children) prev.children.push(c);
        } else {
          prev.children.push(node);
        }
      } else {
        // Promote prev into a new OR group
        const group: OrGroup = {
          kind: "or",
          id: uid("og"),
          children: [],
        };
        if (isOrGroup(prev)) {
          // prev is a negated group; lift its children but keep negation by
          // pushing a NOT-flag through (rare path: `!a | b` doesn't apply).
          for (const c of prev.children) group.children.push(c);
        } else {
          group.children.push(prev);
        }
        if (isOrGroup(node)) {
          for (const c of node.children) group.children.push(c);
        } else {
          group.children.push(node);
        }
        roots[roots.length - 1] = group;
      }
      pendingOr = false;
      continue;
    }

    roots.push(node);
    pendingOr = false;
  }

  return roots;
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Parse a raw query string into a `FilterExpression` tree.
 *
 * Syntax:
 *   `class:H21 status:ok`              — implicit AND
 *   `class:H21 & status:ok`            — explicit AND
 *   `class:H21 | class:D21`            — OR (forms a group)
 *   `(class:H21 | class:D21) ok`       — explicit grouping
 *   `!status:dns`  /  `class:H21 -- !(...)`  — negation
 *   `name:"Anna Svensson"`             — quoted value
 *   `class:H21,D21`                    — in-list (unquoted commas split)
 *   `class:"Öppen 1","Öppen 2"`        — in-list of multi-word items
 *   `name:"Kempe, Hugo"`               — quoted: the comma is literal
 */
export function parseExpression(
  raw: string,
  anchors: AnchorDef<never>[],
): FilterExpression {
  if (!raw.trim()) return { roots: [] };
  const state: ParserState = {
    tokens: lex(raw.trim()),
    pos: 0,
    anchorMap: new Map(anchors.map((a) => [a.key.toLowerCase(), a])),
  };
  return { roots: parseRoot(state) };
}

/**
 * Legacy parser — returns a flat list of root atoms only. OR groups are
 * silently flattened into their child atoms (so `class:H21 | class:D21`
 * yields two AND-ed atoms via this path; callers that care about OR
 * should use `parseExpression`).
 *
 * @deprecated Prefer `parseExpression` for new call sites.
 */
export function parseQuery(
  raw: string,
  anchors: AnchorDef<never>[],
): FilterToken[] {
  const expr = parseExpression(raw, anchors);
  const flat: FilterToken[] = [];
  for (const node of expr.roots) {
    if (isOrGroup(node)) {
      for (const c of node.children) flat.push(c);
    } else {
      flat.push(node);
    }
  }
  return flat;
}

// ─── Serializer ────────────────────────────────────────────────────────

/**
 * True when a value must be quoted to survive a parse round-trip: either
 * it contains structural characters, or it contains a character that
 * would otherwise be re-read as a different operator than the one the
 * atom actually carries.
 */
function needsQuoting(value: string, operator: FilterOperator): boolean {
  if (!value) return true;
  if (/[\s()|&"]/.test(value)) return true;
  if (value.startsWith("!")) return true;
  if (operator !== "in" && value.includes(",")) return true;
  if (operator !== "wildcard" && value.includes("*")) return true;
  return false;
}

/** Quote a literal value when it would not otherwise survive a re-parse. */
export function quoteLiteral(value: string): string {
  return needsQuoting(value, "eq") ? `"${value}"` : value;
}

const RANGE_PREFIX_BY_OP: Partial<Record<FilterOperator, string>> = {
  gt: ">",
  lt: "<",
  gte: ">=",
  lte: "<=",
};

function serializeAtomValue(token: Atom): string {
  // `in` lists are quoted per item so that a multi-word value keeps its
  // spaces without the comma disappearing inside a quoted run.
  if (token.operator === "in") {
    return splitList(token.value).map(quoteLiteral).join(",");
  }
  const prefix = RANGE_PREFIX_BY_OP[token.operator] ?? "";
  const value = needsQuoting(token.value, token.operator)
    ? `"${token.value}"`
    : token.value;
  return prefix + value;
}

/** Serialize an atom's `anchor:value` body, without the `!` negation prefix. */
export function serializeAtomBody(token: Atom): string {
  const value = serializeAtomValue(token);
  return token.anchor ? `${token.anchor}:${value}` : value;
}

function serializeAtom(token: Atom): string {
  const body = serializeAtomBody(token);
  return token.negated ? `!${body}` : body;
}

function serializeGroup(group: OrGroup): string {
  if (group.children.length === 0) return "";
  if (group.children.length === 1) {
    const only = group.children[0];
    const inner = serializeAtom(only);
    return group.negated ? `!${inner}` : inner;
  }
  const inner = group.children.map(serializeAtom).join("|");
  return group.negated ? `!(${inner})` : `(${inner})`;
}

/** Serialize a `FilterExpression` back into the canonical query string. */
export function serializeExpression(expr: FilterExpression): string {
  return expr.roots
    .map((node) => (isOrGroup(node) ? serializeGroup(node) : serializeAtom(node)))
    .filter(Boolean)
    .join(" ");
}

/**
 * Legacy serializer — accepts a flat `FilterToken[]` (atoms only) and
 * emits the canonical AND-joined form.
 *
 * @deprecated Prefer `serializeExpression` for new call sites.
 */
export function serializeTokens(tokens: FilterToken[]): string {
  return serializeExpression({ roots: tokens });
}
