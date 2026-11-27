/**
 * SVG graphics are validated by parsing, not by pattern matching
 * (docs/course-maps.md "SVG validation").
 *
 * 1. `precheck` refuses what a parser would hide or disagree about: a
 *    non-UTF-8 encoding, control characters, processing instructions, and a
 *    DOCTYPE that is anything but plain `<!ENTITY name "value">` declarations.
 * 2. `fast-xml-parser` validates well-formedness and parses to a tree
 *    (comments dropped, CDATA as text, entities not expanded).
 * 3. The tree is walked: forbidden elements, event attributes, non-local
 *    references and CSS `url()` are refused.
 * 4. The tree is serialised again (`canonical`). That serialisation, never the
 *    uploaded bytes, is what resvg renders, so whatever the validator read is
 *    exactly what the rasteriser reads.
 */

import { XMLParser, XMLValidator } from "fast-xml-parser";

const FORBIDDEN_ELEMENTS = new Set([
  "script", "foreignobject", "iframe", "object", "embed", "audio", "video", "link", "meta", "base", "handler", "listener",
]);
const ANIMATION_ELEMENTS = new Set(["set", "animate", "animatetransform", "animatemotion"]);
const NAME = /^(?:[A-Za-z_][A-Za-z0-9_.-]*:)?[A-Za-z_][A-Za-z0-9_.-]*$/;
const MAX_DEPTH = 256;
const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** An embedded raster: the only non-local `href` / `src` an SVG may carry. */
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp)(?:;[^,;]*)*;base64,/i;
/** An embedded font (`@font-face` from Illustrator or Affinity): allowed in CSS `url()` only. */
const DATA_FONT = /^data:(?:font\/[\w.+-]+|application\/(?:x-)?font-[\w.+-]+|application\/vnd\.ms-fontobject|application\/octet-stream)(?:;[^,;]*)*;base64,/i;

function refuse(what: string): never {
  throw new Error(`The SVG must not contain ${what}`);
}

const localName = (name: string) => name.slice(name.lastIndexOf(":") + 1);

/** Character references and predefined entities expanded in one pass; any other entity goes to `custom` or is refused. */
function decodeXml(text: string, custom?: Map<string, string>): string {
  const out = text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[^\s;&<>"']+);/g, (_m, ref: string) => {
    if (ref[0] === "#") {
      const n = ref[1] === "x" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      const valid = Number.isInteger(n) && (n === 9 || n === 10 || n === 13 || (n >= 0x20 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) && n !== 0xfffe && n !== 0xffff));
      if (!valid) refuse("an invalid character reference");
      return String.fromCodePoint(n);
    }
    if (ref in PREDEFINED) return PREDEFINED[ref];
    const value = custom?.get(ref);
    if (value === undefined) refuse("references to custom entities outside namespace declarations");
    return value;
  });
  return out;
}

/** `decodeXml` that also refuses a stray `&` (not a reference) in the source. */
function decodeStrict(text: string, custom?: Map<string, string>): string {
  const stripped = text.replace(/&(?:#x[0-9a-fA-F]+|#[0-9]+|[^\s;&<>"']+);/g, "");
  if (stripped.includes("&")) refuse("a bare ampersand");
  return decodeXml(text, custom);
}

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\t/g, "&#9;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;");

/** What the raw text may contain before a parser reads it; returns the general entities the DOCTYPE declares (first wins). */
function precheck(raw: string): Map<string, string> {
  const decl = /^\s*<\?xml\s[^?]*\?>/.exec(raw);
  if (decl) {
    const enc = /\bencoding\s*=\s*(["'])([^"']*)\1/i.exec(decl[0]);
    if (enc && !/^utf-?8$/i.test(enc[2])) refuse("a non-UTF-8 encoding declaration");
  }
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(raw)) refuse("control characters");
  const pis = [...raw.matchAll(/<\?/g)];
  if (pis.length > (decl ? 1 : 0)) refuse("processing instructions");
  if (!decl && pis.length) refuse("processing instructions");
  const entities = new Map<string, string>();
  const doctypes = [...raw.matchAll(/<!DOCTYPE/gi)];
  if (doctypes.length > 1) refuse("more than one DOCTYPE");
  if (doctypes.length === 1) scanDoctype(raw, doctypes[0].index + 9, entities);
  return entities;
}

/** Reads one DOCTYPE from `pos` (after `<!DOCTYPE`) sequentially; only plain general `<!ENTITY>` declarations are accepted. */
function scanDoctype(raw: string, start: number, entities: Map<string, string>): void {
  const bad = () => refuse("DOCTYPE declarations other than plain entities");
  let i = start;
  const ws = () => {
    while (i < raw.length && /\s/.test(raw[i])) i++;
  };
  const quoted = (): string => {
    const q = raw[i];
    if (q !== '"' && q !== "'") bad();
    const end = raw.indexOf(q, i + 1);
    if (end < 0) bad();
    const value = raw.slice(i + 1, end);
    i = end + 1;
    return value;
  };
  ws();
  const nameEnd = /[\s[>]/.exec(raw.slice(i));
  if (!nameEnd || nameEnd.index === 0) bad();
  i += nameEnd!.index;
  ws();
  if (/^(?:PUBLIC|SYSTEM)\b/i.test(raw.slice(i, i + 7))) {
    const kind = raw.slice(i, i + 6).toUpperCase();
    i += 6;
    ws();
    quoted();
    if (kind === "PUBLIC") {
      ws();
      quoted();
    }
    ws();
  }
  if (raw[i] === "[") {
    i++;
    for (;;) {
      ws();
      if (raw[i] === "]") {
        i++;
        break;
      }
      const m = /^<!ENTITY\s+([^\s%&;"'<>]+)\s+/.exec(raw.slice(i, i + 4096));
      if (!m) bad();
      i += m![0].length;
      const value = quoted();
      ws();
      if (raw[i] !== ">") bad();
      i++;
      if (/%/.test(value)) bad();
      if (!entities.has(m![1])) entities.set(m![1], value);
    }
    ws();
  }
  if (raw[i] !== ">") bad();
}

type XmlNode = Record<string, unknown>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: false,
  htmlEntities: false,
  trimValues: false,
  cdataPropName: "__cdata",
  ignoreDeclaration: true,
  ignorePiTags: true,
  parseTagValue: false,
  parseAttributeValue: false,
  allowBooleanAttributes: false,
});

// ---- CSS -----------------------------------------------------------------

/** CSS with comments removed and escapes decoded, read in one pass so an escape cannot open or close a comment. */
export function normaliseCss(css: string): string {
  let out = "";
  let i = 0;
  let quote = "";
  while (i < css.length) {
    const c = css[i];
    if (c === "\\") {
      const hex = /^[0-9a-fA-F]{1,6}/.exec(css.slice(i + 1, i + 7));
      if (hex) {
        const n = Number.parseInt(hex[0], 16);
        out += n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "�";
        i += 1 + hex[0].length;
        if (/[ \t\r\n\f]/.test(css[i] ?? "")) i += css[i] === "\r" && css[i + 1] === "\n" ? 2 : 1;
      } else if (i + 1 < css.length) {
        if (css[i + 1] !== "\n") out += css[i + 1];
        i += 2;
      } else i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
      out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Throws unless the CSS (a style element or any attribute value) reaches nothing outside the document. */
export function assertSafeCss(css: string): void {
  const text = normaliseCss(css);
  if (/@import/i.test(text)) refuse("@import rules");
  if (/image-set\(/i.test(text)) refuse("image-set()");
  if (/expression\(/i.test(text)) refuse("expression()");
  if (/javascript:/i.test(text)) refuse("javascript: URLs");
  const calls = [...text.matchAll(/url\(/gi)].length;
  let matched = 0;
  for (const m of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/gi)) {
    matched++;
    const target = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!target.startsWith("#") && !DATA_IMAGE.test(target) && !DATA_FONT.test(target)) refuse("external references");
  }
  if (matched !== calls) refuse("external references");
}

// ---- tree walk -----------------------------------------------------------

interface Walk {
  entities: Map<string, string>;
  out: string[];
  root?: Record<string, string>;
}

function attributesOf(node: XmlNode): Array<[string, string]> {
  const attrs = (node[":@"] ?? {}) as Record<string, unknown>;
  return Object.entries(attrs).map(([key, value]) => [key.replace(/^@_/, ""), String(value)]);
}

function checkAttribute(element: string, name: string, value: string): void {
  if (!NAME.test(name)) refuse("unusual attribute names");
  const local = localName(name).toLowerCase();
  if (/^on/i.test(local)) refuse("event handler attributes");
  if (local === "href" || local === "src") {
    const v = value.trim();
    if (!v.startsWith("#") && !DATA_IMAGE.test(v)) refuse("external references");
  }
  assertSafeCss(value);
  if (ANIMATION_ELEMENTS.has(element) && local === "attributename") {
    const target = localName(value.trim()).toLowerCase();
    if (target === "href" || target === "src" || target.startsWith("on")) refuse("animations of links or event handlers");
  }
  if (ANIMATION_ELEMENTS.has(element) && ["to", "from", "values", "by"].includes(local)) {
    for (const item of value.split(";")) {
      if (/^\s*(?:[a-z][a-z0-9+.-]*:|[/\\])/i.test(item) && !item.trim().startsWith("#")) refuse("external references");
    }
  }
}

function walk(nodes: unknown, state: Walk, depth: number): void {
  if (depth > MAX_DEPTH) refuse("elements nested more than 256 deep");
  if (!Array.isArray(nodes)) return;
  for (const raw of nodes) {
    const node = raw as XmlNode;
    if ("#text" in node) {
      state.out.push(escapeText(decodeStrict(String(node["#text"]))));
      continue;
    }
    if ("__cdata" in node) {
      const inner = (node.__cdata as XmlNode[]).map((n) => String(n["#text"] ?? "")).join("");
      state.out.push(escapeText(inner));
      continue;
    }
    const tag = Object.keys(node).find((k) => k !== ":@");
    if (tag === undefined) continue;
    if (!NAME.test(tag)) refuse("unusual element names");
    const local = localName(tag).toLowerCase();
    if (FORBIDDEN_ELEMENTS.has(local)) refuse(`${localName(tag)} elements`);
    if (/^xsl:/i.test(tag) || /^(?:stylesheet|transform)$/i.test(local) && tag.includes(":")) refuse("stylesheet processing instructions or XSLT");
    if (depth === 0 && local !== "svg") throw new Error("The SVG file has no <svg> root element");
    const attrs: Array<[string, string]> = [];
    for (const [name, rawValue] of attributesOf(node)) {
      const isNs = name === "xmlns" || name.startsWith("xmlns:");
      const value = decodeStrict(rawValue, isNs ? state.entities : undefined);
      if (isNs && /XSL\/Transform/i.test(value)) refuse("stylesheet processing instructions or XSLT");
      checkAttribute(local, name, value);
      attrs.push([name, value]);
    }
    if (depth === 0) state.root = Object.fromEntries(attrs);
    const children = node[tag] as unknown[];
    const open = `<${tag}${attrs.map(([n, v]) => ` ${n}="${escapeAttr(v)}"`).join("")}`;
    if (local === "style") {
      const text = flatText(children);
      assertSafeCss(text);
    }
    if (children.length === 0) {
      state.out.push(`${open}/>`);
    } else {
      state.out.push(`${open}>`);
      walk(children, state, depth + 1);
      state.out.push(`</${tag}>`);
    }
  }
}

/** A style element's text as the CSS parser reads it: character data and CDATA, entities decoded. */
function flatText(children: unknown[]): string {
  let text = "";
  for (const raw of children) {
    const node = raw as XmlNode;
    if ("#text" in node) text += decodeStrict(String(node["#text"]));
    else if ("__cdata" in node) text += (node.__cdata as XmlNode[]).map((n) => String(n["#text"] ?? "")).join("");
    else text += flatText((node[Object.keys(node).find((k) => k !== ":@") ?? ""] as unknown[]) ?? []);
  }
  return text;
}

export interface SvgAnalysis {
  /** The validated document, serialised again: what the rasteriser reads. */
  canonical: string;
  /** `minX minY width height`. */
  viewBox: string;
}

/** Validates an SVG upload and returns its canonical serialisation; throws an `Error` whose message says what is wrong. */
export function analyseSvg(data: Uint8Array | string): SvgAnalysis {
  let raw = typeof data === "string" ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const entities = precheck(raw);
  const valid = XMLValidator.validate(raw);
  if (valid !== true) throw new Error("The SVG file is malformed");
  let tree: unknown;
  try {
    tree = parser.parse(raw);
  } catch {
    throw new Error("The SVG file is malformed");
  }
  const top = (tree as XmlNode[]).filter((n) => !("#text" in n) || String(n["#text"]).trim() !== "");
  if (top.length === 0) throw new Error("The SVG file has no <svg> root element");
  if (top.length !== 1 || "#text" in top[0] || "__cdata" in top[0]) throw new Error("The SVG file is malformed");
  const state: Walk = { entities, out: [] };
  walk(top, state, 0);
  const root = state.root ?? {};
  let viewBox = root.viewBox?.trim();
  if (!viewBox) {
    const width = Number.parseFloat(/^\s*([\d.]+)[a-z%]*\s*$/i.exec(root.width ?? "")?.[1] ?? "");
    const height = Number.parseFloat(/^\s*([\d.]+)[a-z%]*\s*$/i.exec(root.height ?? "")?.[1] ?? "");
    if (!(width > 0) || !(height > 0)) throw new Error("The SVG needs a viewBox or numeric width and height");
    viewBox = `0 0 ${width} ${height}`;
  }
  const parts = viewBox.split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) throw new Error("The SVG viewBox is not valid");
  return { canonical: state.out.join(""), viewBox: parts.join(" ") };
}

/**
 * The bytes the rasteriser may read for a stored graphic: the canonical
 * serialisation of its validated tree. A graphic that no longer validates
 * (the rules were tightened after it was stored) gives `null` and a warning;
 * callers render nothing for it.
 */
export function renderableSvg(data: Uint8Array): Buffer | null {
  try {
    return Buffer.from(analyseSvg(data).canonical, "utf8");
  } catch (error) {
    console.warn(`An SVG graphic was not rendered: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
