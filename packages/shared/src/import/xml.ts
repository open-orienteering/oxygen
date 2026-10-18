/**
 * Minimal XML tokenizer for the OpenOrienteering Mapper file format
 * (`docs/map-import.md` §4). Mapper writes its files with Qt's
 * `QXmlStreamWriter`: UTF-8, no DTD, the five predefined entities plus
 * numeric character references, no namespace prefixes. That is all this
 * parser handles; it is dependency-free so stages 3–4 keep running in the
 * browser and in worker threads.
 *
 * Event-based (SAX-like) so the caller can stream the object list without
 * building a tree of the whole file. `parseXmlTree` builds a tree for the
 * parts that are small (symbols, colours, georeferencing).
 */

export interface XmlAttributes {
  [name: string]: string;
}

export interface XmlHandlers {
  start(name: string, attrs: XmlAttributes): void;
  end(name: string): void;
  /** Character data, entities decoded. Whitespace-only runs are delivered too. */
  text(text: string): void;
}

export class XmlParseError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} (at offset ${offset})`);
    this.name = "XmlParseError";
    this.offset = offset;
  }
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Decode `&lt;`, `&#65;`, `&#x41;` …; unknown named entities are left as written. */
export function decodeXmlEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

const isNameStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58 || c > 127;
const isNameChar = (c: number) => isNameStart(c) || (c >= 48 && c <= 57) || c === 45 || c === 46;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

/** Run the tokenizer over a whole document string. Throws `XmlParseError` on malformed markup. */
export function parseXml(src: string, h: XmlHandlers): void {
  const n = src.length;
  let i = 0;
  let rootSeen = false;
  const open: string[] = [];
  const fail = (msg: string, at = i): never => {
    throw new XmlParseError(msg, at);
  };
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      const rest = src.slice(i);
      if (open.length === 0) {
        if (rest.trim() !== "") fail("text after the root element");
      } else h.text(decodeXmlEntities(rest));
      i = n;
      break;
    }
    if (lt > i) {
      const text = src.slice(i, lt);
      if (open.length === 0) {
        if (text.trim() !== "") fail("text outside the root element", i);
      } else h.text(decodeXmlEntities(text));
    }
    i = lt + 1;
    if (i >= n) fail("unexpected end of input");
    const c = src.charCodeAt(i);
    if (c === 63) {
      // <? ... ?>
      const end = src.indexOf("?>", i);
      if (end < 0) fail("unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (c === 33) {
      // <!-- -->, <![CDATA[ ]]>, <!DOCTYPE >
      if (src.startsWith("!--", i)) {
        const end = src.indexOf("-->", i + 3);
        if (end < 0) fail("unterminated comment");
        i = end + 3;
        continue;
      }
      if (src.startsWith("![CDATA[", i)) {
        const end = src.indexOf("]]>", i + 8);
        if (end < 0) fail("unterminated CDATA section");
        if (open.length === 0) fail("CDATA outside the root element");
        h.text(src.slice(i + 8, end));
        i = end + 3;
        continue;
      }
      // DOCTYPE or other declaration: skip to the matching '>' (no internal subset support).
      const end = src.indexOf(">", i);
      if (end < 0) fail("unterminated declaration");
      i = end + 1;
      continue;
    }
    if (c === 47) {
      // </name>
      i++;
      const s = i;
      while (i < n && isNameChar(src.charCodeAt(i))) i++;
      const name = src.slice(s, i);
      while (i < n && isSpace(src.charCodeAt(i))) i++;
      if (src.charCodeAt(i) !== 62) fail("malformed end tag");
      i++;
      const expected = open.pop();
      if (expected !== name) fail(`end tag </${name}> does not match <${expected ?? ""}>`, s);
      h.end(name);
      continue;
    }
    // <name attr="v" ...> or <name .../>
    if (!isNameStart(c)) fail("malformed start tag");
    const s = i;
    while (i < n && isNameChar(src.charCodeAt(i))) i++;
    const name = src.slice(s, i);
    const attrs: XmlAttributes = {};
    let selfClosing = false;
    for (;;) {
      while (i < n && isSpace(src.charCodeAt(i))) i++;
      if (i >= n) fail("unterminated start tag", s);
      const ch = src.charCodeAt(i);
      if (ch === 62) {
        i++;
        break;
      }
      if (ch === 47) {
        if (src.charCodeAt(i + 1) !== 62) fail("malformed empty-element tag");
        selfClosing = true;
        i += 2;
        break;
      }
      if (!isNameStart(ch)) fail("malformed attribute");
      const as = i;
      while (i < n && isNameChar(src.charCodeAt(i))) i++;
      const aname = src.slice(as, i);
      while (i < n && isSpace(src.charCodeAt(i))) i++;
      if (src.charCodeAt(i) !== 61) fail(`attribute ${aname} without value`);
      i++;
      while (i < n && isSpace(src.charCodeAt(i))) i++;
      const q = src.charCodeAt(i);
      if (q !== 34 && q !== 39) fail(`attribute ${aname} value not quoted`);
      const vs = i + 1;
      const ve = src.indexOf(String.fromCharCode(q), vs);
      if (ve < 0) fail(`attribute ${aname} value unterminated`);
      attrs[aname] = decodeXmlEntities(src.slice(vs, ve));
      i = ve + 1;
    }
    if (open.length === 0 && rootSeen) fail("second root element", s);
    rootSeen = true;
    h.start(name, attrs);
    if (selfClosing) h.end(name);
    else open.push(name);
  }
  if (open.length) fail(`unclosed element <${open[open.length - 1]}>`, n);
}

/** A parsed element. `text` is the concatenated character data directly inside it. */
export interface XmlElement {
  name: string;
  attrs: XmlAttributes;
  children: XmlElement[];
  text: string;
}

/** Child elements with a name. */
export function childrenNamed(e: XmlElement, name: string): XmlElement[] {
  return e.children.filter((c) => c.name === name);
}
export function childNamed(e: XmlElement, name: string): XmlElement | undefined {
  return e.children.find((c) => c.name === name);
}

/**
 * Build a tree. `prune(path)` — called at every start tag with the element
 * path from the root — may return a handler that consumes that subtree
 * instead of keeping it: the tokenizer still parses the subtree, hands it
 * to the handler as a tree when it closes, and does not attach it to the
 * parent. This is how the object list is streamed into typed arrays.
 */
export type XmlPrune = (path: readonly string[], attrs: XmlAttributes) => ((e: XmlElement) => void) | "discard" | undefined;

export function parseXmlTree(src: string, prune?: XmlPrune): XmlElement {
  const stack: XmlElement[] = [];
  const path: string[] = [];
  let root: XmlElement | undefined;
  // Depth at which a pruned subtree started, and its consumer ("discard" = drop without building).
  let pruneDepth = -1;
  let consumer: ((e: XmlElement) => void) | "discard" | undefined;
  parseXml(src, {
    start(name, attrs) {
      path.push(name);
      const e: XmlElement = { name, attrs, children: [], text: "" };
      if (pruneDepth < 0 && prune) {
        const c = prune(path, attrs);
        if (c) {
          pruneDepth = stack.length;
          consumer = c;
        }
      }
      if (stack.length) {
        // Inside a consumed subtree the children still link up so the consumer gets a full tree.
        if (pruneDepth < 0 || (stack.length > pruneDepth && consumer !== "discard")) stack[stack.length - 1].children.push(e);
      } else root = e;
      stack.push(e);
    },
    end() {
      const e = stack.pop()!;
      path.pop();
      if (pruneDepth >= 0 && stack.length === pruneDepth) {
        if (consumer !== "discard") consumer!(e);
        pruneDepth = -1;
        consumer = undefined;
      }
    },
    text(t) {
      if (stack.length && consumer !== "discard") stack[stack.length - 1].text += t;
    },
  });
  if (!root) throw new XmlParseError("empty document", 0);
  return root;
}
