import { describe, expect, it } from "vitest";
import { OBJECT_TYPE, decodeMapDocument, encodeMapDocument, type MapDocument, type MapDocumentInput, type MapObjectInput } from "../index.js";
import {
  ADDED_SOURCE_INDEX,
  applyPatch,
  mapPatchSchema,
  mergePatch,
  patchChangeSchema,
  patchOpId,
  patchOpSchema,
  patchSymbolSchema,
  type MapPatch,
  type MapPatchInput,
  type PatchOp,
  type PatchSymbol,
} from "../patch.js";

const HASH = "ab".repeat(32);

const header: MapDocumentInput["header"] = {
  format: { version: 1, importer: "test-1" },
  source: { kind: "ocad", version: "2018.8.3", hash: "00".repeat(32), bytes: 1 },
  unitsPerMm: 100,
  mapScale: 15000,
  georeferencing: { crs: null, paperOrigin: null, gridRotationDeg: 0 },
  colours: [
    { id: "src:0", name: "Black", cmyk: [0, 0, 0, 1], sourceNumber: 0 },
    { id: "src:1", name: "Brown", cmyk: [0, 0.56, 1, 0.18], sourceNumber: 1 },
  ],
  symbols: [
    { code: "101.0", name: "Contour", kind: "line", render: { type: "line", id: "s:101", code: "101", name: "Contour", main: { colour: 1, widthUm: 140 } } },
    { code: "107.0", name: "Gully", kind: "line", render: { type: "line", id: "s:107", code: "107", name: "Gully", main: { colour: 1, widthUm: 250 } } },
    { code: "201.0", name: "Cliff", kind: "point", render: { type: "point", id: "s:201", code: "201", name: "Cliff", glyph: { rotatable: true, parts: [{ kind: "disc", colour: 0, diameterUm: 400 }] } } },
    { code: "403.0", name: "Field", kind: "area", render: { type: "area", id: "s:403", code: "403", name: "Field", fill: 1 } },
    { code: "821.0", name: "Name", kind: "text", render: { type: "text", id: "s:821", code: "821", name: "Name", fontFamily: "liberation-sans", fontSizeUm: 4000, colour: 0 } },
  ],
};

const obj = (o: Partial<MapObjectInput> & { coords: number[] }): MapObjectInput => ({
  symbolIdx: 0, type: OBJECT_TYPE.line, sourceIndex: 0, flags: new Array(o.coords.length / 2).fill(0), ...o,
});

/**
 * Source order 0..4 is deliberately not Hilbert order: object 0 sits at the
 * far corner, so the encoder writes it last and `sourceIndex ≠ objectIndex`.
 */
const makeDoc = (): MapDocument =>
  decodeMapDocument(
    encodeMapDocument({
      header,
      objects: [
        obj({ sourceIndex: 10, coords: [9000, 9000, 9500, 9000] }),
        obj({ sourceIndex: 11, symbolIdx: 1, coords: [0, 0, 1000, 0, 1000, 500] }),
        obj({ sourceIndex: 12, symbolIdx: 2, type: OBJECT_TYPE.point, angleDeciDeg: 450, coords: [2000, 2000] }),
        obj({ sourceIndex: 13, symbolIdx: 3, type: OBJECT_TYPE.area, coords: [0, 3000, 1000, 3000, 1000, 4000, 0, 4000] }),
        obj({ sourceIndex: 14, symbolIdx: 4, type: OBJECT_TYPE.text, text: "Norra", coords: [500, 6000, 0, 5800, 1000, 5800, 1000, 6200, 0, 6200] }),
      ],
    }),
  );

const indexOfSource = (doc: MapDocument, s: number): number => Array.from(doc.attrs.sourceIndex).indexOf(s);

const objectCoords = (doc: MapDocument, i: number): number[][] => {
  const out: number[][] = [];
  for (let k = doc.coordStart[i]; k < doc.coordStart[i + 1]; k++) out.push([doc.coords[k * 2], doc.coords[k * 2 + 1], doc.flags[k]]);
  return out;
};

/** An applied patch without the document's `text` closure (compared through its values instead). */
const plain = ({ document, issues }: ReturnType<typeof applyPatch>) => {
  const { text: _t, ...rest } = document;
  void _t;
  return { document: rest, texts: Array.from({ length: document.header.objects.count }, (_, i) => document.text(i)), issues };
};

const bbox = (doc: MapDocument, i: number): number[] => Array.from(doc.bboxes.subarray(i * 4, i * 4 + 4));

const boulder: PatchSymbol = patchSymbolSchema.parse({
  code: "206", name: "Gigantic boulder", kind: "point",
  render: { type: "point", id: "ISOM2017-2:206", code: "206", name: "Gigantic boulder", glyph: { rotatable: false, parts: [{ kind: "disc", colour: 0, diameterUm: 800 }] } },
});
const track: PatchSymbol = patchSymbolSchema.parse({
  code: "801", name: "Ski track", kind: "line",
  render: { type: "line", id: "ISSkiOM2019:801", code: "801", name: "Ski track", main: { colour: 0, widthUm: 700 } },
});

const ID_A = "019a7d2e-0000-7000-8000-000000000001";
const ID_B = "019a7d2e-0000-7000-8000-000000000002";

const patchOf = (ops: PatchOp[], symbols: Record<string, PatchSymbol> = {}, enabled = true): MapPatch =>
  mapPatchSchema.parse({ documentHash: HASH, enabled, ops: Object.fromEntries(ops.map((op) => [patchOpId(op), op])), symbols } satisfies MapPatchInput);

describe("patch schema", () => {
  it("parses each keyed state with its op id", () => {
    const ops: PatchOp[] = [
      { op: "hide", sourceIndex: 11 },
      { op: "modify", sourceIndex: 11, coords: [[0, 0], [10, 10, 1]], angle: 900 },
      { op: "resymbol", sourceIndex: 11, symbol: { doc: 0 } },
      { op: "add", id: ID_A, type: OBJECT_TYPE.point, symbol: { patch: "ISOM2017-2:206" }, coords: [[1, 2]] },
    ];
    expect(ops.map(patchOpId)).toEqual(["hide:11", "modify:11", "resymbol:11", `add:${ID_A}`]);
    for (const op of ops) expect(patchOpSchema.parse(op)).toEqual(op);
    const p = patchOf(ops, { "ISOM2017-2:206": boulder });
    expect(Object.keys(p.ops)).toEqual(["hide:11", "modify:11", "resymbol:11", `add:${ID_A}`]);
  });

  it("defaults enabled, ops and symbols", () => {
    expect(mapPatchSchema.parse({ documentHash: HASH })).toEqual({ documentHash: HASH, enabled: true, ops: {}, symbols: {} });
  });

  it("rejects a key that is not the op's id", () => {
    const r = mapPatchSchema.safeParse({ documentHash: HASH, ops: { "hide:12": { op: "hide", sourceIndex: 11 } } });
    expect(r.success).toBe(false);
  });

  it.each([
    ["an upper-case uuid", { op: "add", id: ID_A.toUpperCase(), type: 1, symbol: { doc: 0 }, coords: [[0, 0]] }],
    ["a malformed uuid", { op: "add", id: "not-a-uuid", type: 1, symbol: { doc: 0 }, coords: [[0, 0]] }],
    ["a text add", { op: "add", id: ID_A, type: OBJECT_TYPE.text, symbol: { doc: 4 }, coords: [[0, 0]] }],
    ["a fractional coordinate", { op: "modify", sourceIndex: 1, coords: [[0.5, 0]] }],
    ["a coordinate outside int32", { op: "modify", sourceIndex: 1, coords: [[2 ** 31, 0]] }],
    ["a flag byte above 255", { op: "modify", sourceIndex: 1, coords: [[0, 0, 256]] }],
    ["no coordinates", { op: "modify", sourceIndex: 1, coords: [] }],
    ["an angle outside int16", { op: "modify", sourceIndex: 1, coords: [[0, 0]], angle: 40000 }],
    ["a negative sourceIndex", { op: "hide", sourceIndex: -1 }],
    ["a symbol reference with both forms", { op: "resymbol", sourceIndex: 1, symbol: { doc: 0, patch: "x" } }],
  ])("rejects %s", (_name, op) => {
    expect(patchOpSchema.safeParse(op).success).toBe(false);
  });

  it("drops a patch symbol's match and requires a render", () => {
    const withMatch = { ...boulder, sourceIndex: 3, match: { canonicalId: "ISOM2017-2:206", method: "explicit", state: "auto", confidence: 1, libraryVersion: "x" } };
    const p = mapPatchSchema.parse({ documentHash: HASH, symbols: { "ISOM2017-2:206": withMatch } });
    expect(p.symbols["ISOM2017-2:206"]).toEqual(boulder);
    expect(mapPatchSchema.safeParse({ documentHash: HASH, symbols: { k: { ...boulder, render: null } } }).success).toBe(false);
  });

  it("refuses a change that puts one id twice or puts and removes it", () => {
    expect(patchChangeSchema.safeParse({ put: [{ op: "hide", sourceIndex: 1 }, { op: "hide", sourceIndex: 1 }] }).success).toBe(false);
    expect(patchChangeSchema.safeParse({ put: [{ op: "hide", sourceIndex: 1 }], remove: ["hide:1"] }).success).toBe(false);
    expect(patchChangeSchema.safeParse({ put: [{ op: "hide", sourceIndex: 1 }], remove: ["hide:2"] }).success).toBe(true);
  });
});

describe("mergePatch", () => {
  const base = patchOf([{ op: "hide", sourceIndex: 11 }]);

  it("puts by id, replacing a state, and removes", () => {
    const moved = mergePatch(base, { put: [{ op: "modify", sourceIndex: 12, coords: [[1, 1]] }] });
    const again = mergePatch(moved, { put: [{ op: "modify", sourceIndex: 12, coords: [[2, 2]] }], remove: ["hide:11"] });
    expect(again.ops).toEqual({ "modify:12": { op: "modify", sourceIndex: 12, coords: [[2, 2]] } });
  });

  it("removing an absent id changes nothing", () => {
    expect(mergePatch(base, { remove: ["hide:99"] })).toEqual(base);
  });

  it("is idempotent: the same change twice equals once", () => {
    const change = { put: [{ op: "resymbol", sourceIndex: 12, symbol: { patch: "ISOM2017-2:206" } } as PatchOp], putSymbols: { "ISOM2017-2:206": boulder }, remove: ["hide:11"] };
    const once = mergePatch(base, change);
    expect(mergePatch(once, change)).toEqual(once);
    expect(JSON.stringify(mergePatch(once, change))).toBe(JSON.stringify(once));
  });

  it("commutes: changes to different ids in either order give the same patch and the same JSON", () => {
    const a = { put: [{ op: "add", id: ID_B, type: 2, symbol: { patch: "ISSkiOM2019:801" }, coords: [[0, 0], [5, 5]] } as PatchOp], putSymbols: { "ISSkiOM2019:801": track } };
    const b = { put: [{ op: "hide", sourceIndex: 13 } as PatchOp], putSymbols: { "ISOM2017-2:206": boulder } };
    const ab = mergePatch(mergePatch(base, a), b);
    const ba = mergePatch(mergePatch(base, b), a);
    expect(ab).toEqual(ba);
    expect(JSON.stringify(ab)).toBe(JSON.stringify(ba));
    expect(Object.keys(ab.ops)).toEqual([...Object.keys(ab.ops)].sort());
  });

  it("does not mutate its input", () => {
    const snapshot = JSON.stringify(base);
    mergePatch(base, { put: [{ op: "hide", sourceIndex: 12 }], remove: ["hide:11"], putSymbols: { k: boulder } });
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

describe("applyPatch: identity", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["disabled", patchOf([{ op: "hide", sourceIndex: 11 }], {}, false)],
    ["no ops", patchOf([], { "ISOM2017-2:206": boulder })],
  ])("%s returns the document itself", (_name, patch) => {
    const doc = makeDoc();
    const r = applyPatch(doc, patch);
    expect(r.document).toBe(doc);
    expect(r.issues).toEqual([]);
  });
});

describe("applyPatch: document-object ops", () => {
  it("hides the object found by sourceIndex, keeping every index", () => {
    const doc = makeDoc();
    const i = indexOfSource(doc, 10);
    expect(i).not.toBe(0); // the fixture's Hilbert order differs from source order
    const { document: eff, issues } = applyPatch(doc, patchOf([{ op: "hide", sourceIndex: 10 }]));
    expect(issues).toEqual([]);
    expect(eff.header.objects.count).toBe(doc.header.objects.count);
    expect(Array.from(eff.hidden!)).toEqual(Array.from({ length: 5 }, (_, k) => (k === i ? 1 : 0)));
    expect(Array.from(eff.attrs.sourceIndex)).toEqual(Array.from(doc.attrs.sourceIndex));
    // No geometry changed: the arrays are shared.
    expect(eff.coords).toBe(doc.coords);
    expect(eff.bboxes).toBe(doc.bboxes);
  });

  it("modifies coordinates, flags, bbox and angle; neighbours, type and text kept", () => {
    const doc = makeDoc();
    const gully = indexOfSource(doc, 11);
    const cliff = indexOfSource(doc, 12);
    const { document: eff, issues } = applyPatch(doc, patchOf([
      { op: "modify", sourceIndex: 11, coords: [[100, 100], [200, 300, 1], [400, 100], [500, 500]] },
      { op: "modify", sourceIndex: 12, coords: [[2500, 2500]], angle: -900 },
    ]));
    expect(issues).toEqual([]);
    expect(objectCoords(eff, gully)).toEqual([[100, 100, 0], [200, 300, 1], [400, 100, 0], [500, 500, 0]]);
    expect(eff.attrs.coordCount[gully]).toBe(4);
    expect(bbox(eff, gully)).toEqual([100, 100, 500, 500]);
    expect(eff.attrs.type[gully]).toBe(OBJECT_TYPE.line);
    expect(eff.attrs.symbolIdx[gully]).toBe(1);
    expect(objectCoords(eff, cliff)).toEqual([[2500, 2500, 0]]);
    expect(eff.attrs.angle[cliff]).toBe(-900);
    for (let i = 0; i < doc.header.objects.count; i++) {
      if (i === gully || i === cliff) continue;
      expect(objectCoords(eff, i)).toEqual(objectCoords(doc, i));
      expect(bbox(eff, i)).toEqual(bbox(doc, i));
      expect(eff.attrs.angle[i]).toBe(doc.attrs.angle[i]);
      expect(eff.text(i)).toBe(doc.text(i));
    }
    expect(eff.coordStart[eff.header.objects.count]).toBe(doc.coordStart[doc.header.objects.count] + 1);
  });

  it("an angle-less modify keeps the document's rotation; a text object moves with its text", () => {
    const doc = makeDoc();
    const cliff = indexOfSource(doc, 12);
    const name = indexOfSource(doc, 14);
    const moved = [[600, 7000], [100, 6800], [1100, 6800], [1100, 7200], [100, 7200]] as [number, number][];
    const { document: eff, issues } = applyPatch(doc, patchOf([
      { op: "modify", sourceIndex: 12, coords: [[0, 0]] },
      { op: "modify", sourceIndex: 14, coords: moved },
    ]));
    expect(issues).toEqual([]);
    expect(eff.attrs.angle[cliff]).toBe(450);
    expect(eff.text(name)).toBe("Norra");
    expect(objectCoords(eff, name).map(([x, y]) => [x, y])).toEqual(moved);
  });

  it("resymbols to a document symbol and to a patch symbol", () => {
    const doc = makeDoc();
    const { document: eff, issues } = applyPatch(doc, patchOf(
      [
        { op: "resymbol", sourceIndex: 11, symbol: { doc: 0 } },
        { op: "resymbol", sourceIndex: 12, symbol: { patch: "ISOM2017-2:206" } },
      ],
      { "ISOM2017-2:206": boulder },
    ));
    expect(issues).toEqual([]);
    expect(eff.attrs.symbolIdx[indexOfSource(doc, 11)]).toBe(0);
    expect(eff.attrs.symbolIdx[indexOfSource(doc, 12)]).toBe(5);
    expect(eff.header.symbols[5]).toEqual(boulder);
    expect(eff.header.symbols.slice(0, 5)).toEqual(doc.header.symbols);
  });

  it("keeps hide, modify and resymbol of one object as independent states", () => {
    const doc = makeDoc();
    const i = indexOfSource(doc, 11);
    const { document: eff } = applyPatch(doc, patchOf([
      { op: "hide", sourceIndex: 11 },
      { op: "modify", sourceIndex: 11, coords: [[0, 0], [9, 9]] },
      { op: "resymbol", sourceIndex: 11, symbol: { doc: 0 } },
    ]));
    expect(eff.hidden![i]).toBe(1);
    expect(objectCoords(eff, i)).toEqual([[0, 0, 0], [9, 9, 0]]);
    expect(eff.attrs.symbolIdx[i]).toBe(0);
  });
});

describe("applyPatch: added objects and the combined symbol table", () => {
  const adds: PatchOp[] = [
    { op: "add", id: ID_B, type: OBJECT_TYPE.line, symbol: { patch: "ISSkiOM2019:801" }, coords: [[0, 0], [3000, 0, 1], [3000, 3000]] },
    { op: "add", id: ID_A, type: OBJECT_TYPE.point, symbol: { doc: 2 }, coords: [[1500, 1500]], angle: 300 },
  ];
  const symbols = { "ISSkiOM2019:801": track, "ISOM2017-2:206": boulder };

  it("appends added objects after the document's, in op-id order", () => {
    const doc = makeDoc();
    const n = doc.header.objects.count;
    const { document: eff, issues } = applyPatch(doc, patchOf(adds, symbols));
    expect(issues).toEqual([]);
    expect(eff.header.objects.count).toBe(n + 2);
    expect(eff.patch).toEqual({ baseCount: n, baseSymbols: 5, added: [ID_A, ID_B], symbols: ["ISOM2017-2:206", "ISSkiOM2019:801"] });
    // ID_A < ID_B: the point first.
    expect(eff.attrs.type[n]).toBe(OBJECT_TYPE.point);
    expect(eff.attrs.symbolIdx[n]).toBe(2);
    expect(eff.attrs.angle[n]).toBe(300);
    expect(objectCoords(eff, n)).toEqual([[1500, 1500, 0]]);
    expect(eff.attrs.type[n + 1]).toBe(OBJECT_TYPE.line);
    expect(eff.attrs.symbolIdx[n + 1]).toBe(6); // ISSkiOM2019:801 sorts after ISOM2017-2:206
    expect(eff.attrs.angle[n + 1]).toBe(0);
    expect(objectCoords(eff, n + 1)).toEqual([[0, 0, 0], [3000, 0, 1], [3000, 3000, 0]]);
    expect(bbox(eff, n + 1)).toEqual([0, 0, 3000, 3000]);
    for (const k of [n, n + 1]) {
      expect(eff.attrs.sourceIndex[k]).toBe(ADDED_SOURCE_INDEX);
      expect(eff.text(k)).toBeUndefined();
      expect(eff.hidden![k]).toBe(0);
    }
    expect(eff.header.symbols.map((s) => s.code)).toEqual(["101.0", "107.0", "201.0", "403.0", "821.0", "206", "801"]);
    expect(eff.header.bounds).toEqual(doc.header.bounds);
    expect(eff.header.strings).toEqual(doc.header.strings);
  });

  it("leaves every document object at its index with its attributes and geometry", () => {
    const doc = makeDoc();
    const { document: eff } = applyPatch(doc, patchOf(adds, symbols));
    for (let i = 0; i < doc.header.objects.count; i++) {
      expect(eff.attrs.sourceIndex[i]).toBe(doc.attrs.sourceIndex[i]);
      expect(eff.attrs.symbolIdx[i]).toBe(doc.attrs.symbolIdx[i]);
      expect(eff.attrs.type[i]).toBe(doc.attrs.type[i]);
      expect(eff.attrs.angle[i]).toBe(doc.attrs.angle[i]);
      expect(eff.text(i)).toBe(doc.text(i));
      expect(objectCoords(eff, i)).toEqual(objectCoords(doc, i));
      expect(bbox(eff, i)).toEqual(bbox(doc, i));
    }
  });

  it("does not depend on the insertion order of ops and symbols (commutativity)", () => {
    const doc = makeDoc();
    const all: PatchOp[] = [...adds, { op: "hide", sourceIndex: 13 }, { op: "modify", sourceIndex: 11, coords: [[0, 0], [1, 1]] }, { op: "resymbol", sourceIndex: 12, symbol: { patch: "ISOM2017-2:206" } }];
    const forward = applyPatch(doc, patchOf(all, symbols));
    const backward = applyPatch(doc, patchOf([...all].reverse(), { "ISOM2017-2:206": boulder, "ISSkiOM2019:801": track }));
    expect(plain(backward)).toEqual(plain(forward));
  });

  it("is idempotent and leaves its input untouched", () => {
    const doc = makeDoc();
    const before = { attrs: Object.values(doc.attrs).map((a) => Array.from(a)), coords: Array.from(doc.coords), bboxes: Array.from(doc.bboxes), symbols: doc.header.symbols.length, count: doc.header.objects.count };
    const p = patchOf([...adds, { op: "modify", sourceIndex: 11, coords: [[0, 0], [1, 1]] }, { op: "hide", sourceIndex: 13 }], symbols);
    const once = applyPatch(doc, p);
    const twice = applyPatch(doc, mergePatch(p, { put: Object.values(p.ops), putSymbols: p.symbols }));
    expect(plain(twice)).toEqual(plain(once));
    expect({ attrs: Object.values(doc.attrs).map((a) => Array.from(a)), coords: Array.from(doc.coords), bboxes: Array.from(doc.bboxes), symbols: doc.header.symbols.length, count: doc.header.objects.count }).toEqual(before);
  });
});

describe("applyPatch: issues are reported, not thrown", () => {
  it.each<[string, PatchOp, string]>([
    ["an absent target", { op: "hide", sourceIndex: 99 }, "target-missing"],
    ["an absent modify target", { op: "modify", sourceIndex: 99, coords: [[0, 0], [1, 1]] }, "target-missing"],
    ["an absent resymbol target", { op: "resymbol", sourceIndex: 99, symbol: { doc: 0 } }, "target-missing"],
    ["a document symbol out of range", { op: "resymbol", sourceIndex: 11, symbol: { doc: 5 } }, "symbol-missing"],
    ["an absent patch symbol", { op: "resymbol", sourceIndex: 11, symbol: { patch: "ISOM2017-2:999" } }, "symbol-missing"],
    ["a resymbol of another kind", { op: "resymbol", sourceIndex: 11, symbol: { doc: 2 } }, "kind-mismatch"],
    ["an add whose symbol is of another kind", { op: "add", id: ID_A, type: OBJECT_TYPE.area, symbol: { doc: 0 }, coords: [[0, 0], [1, 0], [1, 1]] }, "kind-mismatch"],
    ["an add with an absent symbol", { op: "add", id: ID_A, type: OBJECT_TYPE.point, symbol: { patch: "nope" }, coords: [[0, 0]] }, "symbol-missing"],
    ["a point modified to two coordinates", { op: "modify", sourceIndex: 12, coords: [[0, 0], [1, 1]] }, "geometry-invalid"],
    ["a line of one coordinate", { op: "modify", sourceIndex: 11, coords: [[0, 0]] }, "geometry-invalid"],
    ["an area of two coordinates", { op: "modify", sourceIndex: 13, coords: [[0, 0], [1, 1]] }, "geometry-invalid"],
    ["a text whose coordinate count changes", { op: "modify", sourceIndex: 14, coords: [[0, 0]] }, "geometry-invalid"],
    ["an added line of one coordinate", { op: "add", id: ID_A, type: OBJECT_TYPE.line, symbol: { doc: 0 }, coords: [[0, 0]] }, "geometry-invalid"],
  ])("%s", (_name, bad, code) => {
    const doc = makeDoc();
    const good: PatchOp = { op: "hide", sourceIndex: 10 };
    const { document: eff, issues } = applyPatch(doc, patchOf([bad, good], { "ISOM2017-2:206": boulder }));
    expect(issues).toEqual([{ opId: patchOpId(bad), code }]);
    // The other op still applied; the bad one changed nothing.
    expect(eff.hidden![indexOfSource(doc, 10)]).toBe(1);
    expect(eff.header.objects.count).toBe(doc.header.objects.count);
    for (let i = 0; i < doc.header.objects.count; i++) {
      expect(objectCoords(eff, i)).toEqual(objectCoords(doc, i));
      expect(eff.attrs.symbolIdx[i]).toBe(doc.attrs.symbolIdx[i]);
    }
  });

  it("reports patch symbols that overflow the u16 symbol table", () => {
    const doc = makeDoc();
    const many: Record<string, PatchSymbol> = {};
    // 5 document symbols + 65 531 patch symbols fill the table exactly; key order puts "zz" last.
    for (let k = 0; k < 65_531; k++) many[`k${String(k).padStart(5, "0")}`] = boulder;
    many.zz = boulder;
    const { document: eff, issues } = applyPatch(doc, patchOf([
      { op: "resymbol", sourceIndex: 12, symbol: { patch: "zz" } },
      { op: "add", id: ID_A, type: OBJECT_TYPE.point, symbol: { patch: "k65530" }, coords: [[0, 0]] },
    ], many));
    expect(eff.header.symbols.length).toBe(65_536);
    expect(issues).toEqual([{ opId: "resymbol:12", code: "symbol-table-full" }]);
    expect(eff.attrs.symbolIdx[doc.header.objects.count]).toBe(65_535);
  });
});
