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

function detectOperator(
  rawValue: string,
  defaultOp: FilterOperator,
): [FilterOperator, string] {
  if (rawValue.startsWith(">=")) return ["gte", rawValue.slice(2)];
  if (rawValue.startsWith("<=")) return ["lte", rawValue.slice(2)];
  if (rawValue.startsWith(">")) return ["gt", rawValue.slice(1)];
  if (rawValue.startsWith("<")) return ["lt", rawValue.slice(1)];
  if (rawValue.includes(",")) return ["in", rawValue];
  if (rawValue.includes("*")) return ["wildcard", rawValue];
  return [defaultOp, rawValue];
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
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
      const rawValue = unquote(segment.slice(colonIdx + 1));
      if (!rawValue) return null;
      const [operator, value] = detectOperator(rawValue, anchor.defaultOperator);
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

function serializeAtomValue(token: Atom): string {
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

function serializeAtom(token: Atom): string {
  const value = serializeAtomValue(token);
  const needsQuote =
    value.includes(" ") ||
    value.includes("(") ||
    value.includes(")") ||
    value.includes("|") ||
    value.includes("&");
  const quotedValue = needsQuote ? `"${value}"` : value;
  const body = token.anchor ? `${token.anchor}:${quotedValue}` : quotedValue;
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
