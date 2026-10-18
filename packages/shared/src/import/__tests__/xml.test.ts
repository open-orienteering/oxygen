import { describe, expect, it } from "vitest";
import { childNamed, childrenNamed, decodeXmlEntities, parseXml, parseXmlTree, XmlParseError, type XmlElement } from "../xml.js";

const events = (src: string): string[] => {
  const out: string[] = [];
  parseXml(src, {
    start: (n, a) => out.push(`<${n}${Object.entries(a).map(([k, v]) => ` ${k}=${JSON.stringify(v)}`).join("")}>`),
    end: (n) => out.push(`</${n}>`),
    text: (t) => out.push(JSON.stringify(t)),
  });
  return out;
};

describe("parseXml", () => {
  it("tokenises prolog, elements, attributes, text and self-closing tags", () => {
    expect(events(`<?xml version="1.0" encoding="UTF-8"?>\n<map xmlns="urn:x" version="9"><notes>hi</notes><a b='1' c="x&amp;y"/></map>`)).toEqual([
      `<map xmlns="urn:x" version="9">`, `<notes>`, `"hi"`, `</notes>`, `<a b="1" c="x&y">`, `</a>`, `</map>`,
    ]);
  });

  it("decodes entities and character references in text and attributes, leaves unknown ones", () => {
    expect(decodeXmlEntities("&lt;a&gt; &amp; &quot;q&quot; &apos;s&apos; &#65;&#x42; &nope;")).toBe(`<a> & "q" 's' AB &nope;`);
    expect(events(`<r t="&#xE5;">&#229;</r>`)).toEqual([`<r t="å">`, `"å"`, `</r>`]);
  });

  it("skips comments, DOCTYPE and processing instructions; passes CDATA through verbatim", () => {
    expect(events(`<!DOCTYPE x><r><!-- c --><?pi x?><![CDATA[<raw>&]]></r>`)).toEqual([`<r>`, `"<raw>&"`, `</r>`]);
  });

  it("delivers whitespace runs and multi-line attribute values", () => {
    expect(events("<r>\n <a x=\"1\n2\"/>\n</r>")).toEqual(["<r>", JSON.stringify("\n "), `<a x=${JSON.stringify("1\n2")}>`, "</a>", JSON.stringify("\n"), "</r>"]);
  });

  it("rejects malformed markup with the offset", () => {
    expect(() => events(`<r><a></b></r>`)).toThrow(XmlParseError);
    expect(() => events(`<r>`)).toThrow(/unclosed element <r>/);
    expect(() => events(`<r/><r/>`)).toThrow(/second root/);
    expect(() => events(`<r a=1/>`)).toThrow(/not quoted/);
    expect(() => events(`<r a="1"`)).toThrow(/unterminated start tag/);
    expect(() => events(`text<r/>`)).toThrow(/outside the root/);
    try {
      events(`<r><x></y></r>`);
    } catch (e) {
      expect((e as XmlParseError).offset).toBe(8);
    }
  });
});

describe("parseXmlTree", () => {
  it("builds a tree with concatenated text per element", () => {
    const t = parseXmlTree(`<map><colors count="1"><color priority="0" name="Black"/></colors><notes>a<b/>c</notes></map>`);
    expect(t.name).toBe("map");
    expect(childNamed(t, "colors")!.attrs.count).toBe("1");
    expect(childrenNamed(childNamed(t, "colors")!, "color")[0].attrs.name).toBe("Black");
    expect(childNamed(t, "notes")!.text).toBe("ac");
  });

  it("prunes subtrees into a consumer without attaching them to the parent", () => {
    const seen: XmlElement[] = [];
    const t = parseXmlTree(
      `<map><parts><part><objects count="2"><object type="0"><coords>1 2;</coords></object><object type="1"><coords>3 4;5 6;</coords><pattern rotation="0"><coord x="0" y="0"/></pattern></object></objects></part></parts><view/></map>`,
      (path) => (path[path.length - 1] === "object" && path[path.length - 2] === "objects" ? (e) => seen.push(e) : undefined),
    );
    expect(seen.map((e) => e.attrs.type)).toEqual(["0", "1"]);
    expect(childNamed(seen[1], "coords")!.text).toBe("3 4;5 6;");
    expect(childNamed(childNamed(seen[1], "pattern")!, "coord")!.attrs).toEqual({ x: "0", y: "0" });
    const objects = childNamed(childNamed(childNamed(t, "parts")!, "part")!, "objects")!;
    expect(objects.children).toEqual([]);
    expect(objects.attrs.count).toBe("2");
    expect(childNamed(t, "view")).toBeDefined();
  });

  it("discards subtrees without building them", () => {
    const t = parseXmlTree(`<map><undo><step><object/></step>text</undo><ok/></map>`, (path) => (path[1] === "undo" ? "discard" : undefined));
    expect(t.children.map((c) => c.name)).toEqual(["ok"]);
    expect(t.text).toBe("");
  });
});
