/**
 * A map's colour setting and the colour panel's payload (row I6;
 * docs/map-symbols.md §9.3 "Per map (row I6)", §8.7 "Colour layers"),
 * pure parts. The fixtures' expected values are those of e2e/colour-layers.ocd
 * and e2e/test.ocd as the importer builds them.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mapDocument, mapImport } from "@oxygen/shared";
import { importOcadToDocument } from "../import/ocad.js";
import { buildImportReport } from "../map-store/documents.js";
import {
  colourSettingsOfReport,
  colourSettingsKey,
  defaultDeviationChoice,
  documentFollowsColour,
  matchColourOptions,
  normaliseColourSettings,
  parseColourSettings,
  pictureDeviationsQuery,
  reportDeviationKeys,
  reportFollowsColour,
  sameColourSettings,
  withDeviationChoice,
} from "../map-store/colour-settings.js";
import { colourPictureKey, parseColourOrderFile, parsePictureDeviations } from "../map-store/colour-pictures.js";
import { buildColourReview, colourPictureUrl, roleName } from "../map-store/review-colours.js";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../../../e2e/${name}`, import.meta.url)));

async function imported(name: string, match: mapImport.MatchDocumentOptions = {}) {
  const r = await importOcadToDocument(fixture(name), name, { match });
  const header = mapDocument.decodeMapDocument(r.bytes).header;
  // The stored report is JSON (map_documents.report).
  const report = JSON.parse(JSON.stringify(buildImportReport(r, header, name))) as unknown;
  return { hash: r.documentHash, header, report };
}

const HASH = "a".repeat(64);
const ROAD = "brown50-road>brown100-line";
const YELLOW = "yellow100>black100";

describe("colour settings", () => {
  it("parses a stored setting, reading anything malformed as the defaults", () => {
    expect(parseColourSettings({})).toEqual({ order: "iof", deviations: {} });
    expect(parseColourSettings(null)).toEqual({ order: "iof", deviations: {} });
    expect(parseColourSettings([])).toEqual({ order: "iof", deviations: {} });
    expect(parseColourSettings({ order: "nonsense" })).toEqual({ order: "iof", deviations: {} });
    expect(parseColourSettings({ order: "source" })).toEqual({ order: "source", deviations: {} });
    expect(parseColourSettings({ order: "iof", deviations: { [YELLOW]: "keep", bad: "keep", [ROAD]: "maybe" } })).toEqual({ order: "iof", deviations: { [YELLOW]: "keep" } });
  });

  it("normalises: a choice equal to the default is none, keys sorted", () => {
    expect(defaultDeviationChoice(ROAD)).toBe("keep");
    expect(defaultDeviationChoice(YELLOW)).toBe("drop");
    const n = normaliseColourSettings({ order: "iof", deviations: { [YELLOW]: "keep", [ROAD]: "keep", "black100>blue100-line": "keep" } });
    expect(n).toEqual({ order: "iof", deviations: { "black100>blue100-line": "keep", [YELLOW]: "keep" } });
    expect(Object.keys(n.deviations)).toEqual(["black100>blue100-line", YELLOW]);
    expect(sameColourSettings({ order: "iof", deviations: { [ROAD]: "keep" } }, { order: "iof", deviations: {} })).toBe(true);
    expect(sameColourSettings({ order: "iof", deviations: {} }, { order: "source", deviations: {} })).toBe(false);
  });

  it("keeps roads over water by default (ocad-20): a stored keep on the pair is none, a drop is an override", () => {
    const WATER = "brown50-road>blue100-line";
    expect(defaultDeviationChoice(WATER)).toBe("keep");
    expect(defaultDeviationChoice("black-road-outline>blue100-line")).toBe("keep");
    expect(defaultDeviationChoice("brown50-paved>blue100-pointline")).toBe("keep");
    expect(defaultDeviationChoice("blue100-area>brown100-line")).toBe("drop");
    expect(normaliseColourSettings({ order: "iof", deviations: { [WATER]: "keep" } }).deviations).toEqual({});
    expect(normaliseColourSettings({ order: "iof", deviations: { [WATER]: "drop" } }).deviations).toEqual({ [WATER]: "drop" });
  });

  it("gives stage 7 its options, with no deviations key at the defaults", () => {
    expect(matchColourOptions({ order: "iof", deviations: {} })).toEqual({ colourOrder: "iof" });
    expect(matchColourOptions({ order: "source", deviations: { [ROAD]: "drop" } })).toEqual({ colourOrder: "source", deviations: { [ROAD]: "drop" } });
    expect(matchColourOptions({ order: "iof", deviations: { [ROAD]: "keep" } })).toEqual({ colourOrder: "iof" });
  });

  it("reads the setting a document was built with from its report", async () => {
    const iof = await imported("colour-layers.ocd");
    expect(colourSettingsOfReport(iof.report)).toEqual({ order: "iof", deviations: {} });
    const source = await imported("colour-layers.ocd", { colourOrder: "source" });
    expect(colourSettingsOfReport(source.report)).toEqual({ order: "source", deviations: {} });
    const over = await imported("colour-layers.ocd", { deviations: { [ROAD]: "drop", "yellow100>brown50-road": "keep" } });
    expect(colourSettingsOfReport(over.report)).toEqual({ order: "iof", deviations: { [ROAD]: "drop", "yellow100>brown50-road": "keep" } });
    // Before the colour layers (no `order`): the defaults.
    expect(colourSettingsOfReport({ colourStack: { source: 3 } })).toEqual({ order: "iof", deviations: {} });
    // A fallback to the map's order was asked for `iof`.
    expect(colourSettingsOfReport({ colourStack: { order: "source" }, warnings: [{ code: "COLOUR_LAYERS_FAILED" }] }).order).toBe("iof");
  });

  it("tells whether a document follows a setting", async () => {
    const iof = await imported("colour-layers.ocd");
    const source = await imported("colour-layers.ocd", { colourOrder: "source" });
    expect(iof.hash).not.toBe(source.hash);
    expect(reportFollowsColour(iof.report, { order: "iof", deviations: {} })).toBe(true);
    expect(reportFollowsColour(iof.report, { order: "source", deviations: {} })).toBe(false);
    expect(reportFollowsColour(source.report, { order: "source", deviations: {} })).toBe(true);
    // `source` ignores the overrides, as stage 7 does.
    expect(reportFollowsColour(source.report, { order: "source", deviations: { [ROAD]: "drop" } })).toBe(true);
    expect(reportFollowsColour(source.report, { order: "iof", deviations: {} })).toBe(false);
    // An override of a pair the map has makes the default document stale; one of a pair it lacks changes nothing.
    expect(reportFollowsColour(iof.report, { order: "iof", deviations: { [ROAD]: "drop" } })).toBe(false);
    expect(reportFollowsColour(iof.report, { order: "iof", deviations: { "black100>blue100-line": "keep" } })).toBe(true);
    const over = await imported("colour-layers.ocd", { deviations: { [ROAD]: "drop" } });
    expect(reportFollowsColour(over.report, { order: "iof", deviations: { [ROAD]: "drop" } })).toBe(true);
    expect(reportFollowsColour(over.report, { order: "iof", deviations: {} })).toBe(false);
    // A fallback document is what `iof` gives, never what `source` gives.
    const fallback = { colourStack: { order: "source" }, warnings: [{ code: "COLOUR_LAYERS_FAILED" }] };
    expect(reportFollowsColour(fallback, { order: "iof", deviations: {} })).toBe(true);
    expect(reportFollowsColour(fallback, { order: "source", deviations: {} })).toBe(false);
  });
});

describe("a document's colour setting by what gave it (row I7)", () => {
  const BUILDING = "black50-building>brown100-line";
  const PAVED_BUILDING = "brown50-paved>black50-building";

  it("an override that changes no bytes gives the same document, which its report alone does not follow", async () => {
    const plain = await imported("colour-layers.ocd");
    // Kept by implication at the defaults: keeping it explicitly is a no-op.
    const noop = await imported("colour-layers.ocd", { deviations: { [BUILDING]: "keep" } });
    expect(noop.hash).toBe(plain.hash);
    const asked = { order: "iof" as const, deviations: { [BUILDING]: "keep" as const } };
    // The stored report is the first import's: the defaults (the bug carried from I6).
    expect(reportFollowsColour(plain.report, asked)).toBe(false);
    expect(documentFollowsColour({ report: plain.report }, asked)).toBe(false);
    expect(documentFollowsColour({ report: plain.report, recorded: [asked] }, asked)).toBe(true);
    // The recorded setting does not stand in for another one.
    expect(documentFollowsColour({ report: plain.report, recorded: [asked] }, { order: "iof", deviations: { [PAVED_BUILDING]: "keep" } })).toBe(false);
    expect(documentFollowsColour({ report: plain.report, recorded: [asked] }, { order: "source", deviations: {} })).toBe(false);
    // The report still answers for the defaults, with or without rows.
    expect(documentFollowsColour({ report: plain.report, recorded: [asked] }, { order: "iof", deviations: {} })).toBe(true);
  });

  it("compares only what can change the document: overrides of listed pairs, none in the map's own order", async () => {
    const plain = await imported("colour-layers.ocd");
    const recorded = [{ order: "iof" as const, deviations: { [BUILDING]: "keep" as const, "black100>blue100-line": "keep" as const } }];
    expect(documentFollowsColour({ report: plain.report, recorded }, { order: "iof", deviations: { [BUILDING]: "keep" } })).toBe(true);
    const source = await imported("colour-layers.ocd", { colourOrder: "source" });
    expect(documentFollowsColour({ report: source.report, recorded: [] }, { order: "source", deviations: { [BUILDING]: "keep" } })).toBe(true);
  });

  it("keys a setting by its normalised canonical JSON", () => {
    expect(colourSettingsKey({ order: "iof", deviations: {} })).toBe('{"order":"iof","deviations":{}}');
    expect(colourSettingsKey({ order: "iof", deviations: { [YELLOW]: "keep", [ROAD]: "keep" } })).toBe(colourSettingsKey({ order: "iof", deviations: { [YELLOW]: "keep" } }));
    expect(colourSettingsKey({ order: "iof", deviations: { [YELLOW]: "keep", [BUILDING]: "keep" } })).toBe(`{"order":"iof","deviations":{"${BUILDING}":"keep","${YELLOW}":"keep"}}`);
  });
});

describe("the panel's overrides and the picture's key (row I7)", () => {
  const BUILDING = "black50-building>brown100-line";
  const PAVED_BUILDING = "brown50-paved>black50-building";

  it("changes one deviation's choice; a reset or a choice equal to the default removes the key", () => {
    const s = { order: "iof" as const, deviations: { [YELLOW]: "keep" as const } };
    expect(withDeviationChoice(s, ROAD, "drop")).toEqual({ order: "iof", deviations: { [ROAD]: "drop", [YELLOW]: "keep" } });
    expect(withDeviationChoice(s, ROAD, "keep")).toEqual(s);
    expect(withDeviationChoice(s, YELLOW, "default")).toEqual({ order: "iof", deviations: {} });
    expect(withDeviationChoice(s, YELLOW, "drop")).toEqual({ order: "iof", deviations: {} });
    // Kept while the order is the map's own.
    expect(withDeviationChoice({ order: "source", deviations: {} }, ROAD, "drop")).toEqual({ order: "source", deviations: { [ROAD]: "drop" } });
  });

  it("lists a document's deviation keys", async () => {
    expect(reportDeviationKeys((await imported("colour-layers.ocd")).report)).toHaveLength(9);
    expect(reportDeviationKeys((await imported("colour-layers.ocd", { colourOrder: "source" })).report)).toEqual([]);
  });

  it("gives each deviation the map's choice and whether it is overridden, from the setting", async () => {
    const { header, report } = await imported("colour-layers.ocd");
    const by = (v: ReturnType<typeof buildColourReview>, key: string) => v.deviations.find((d) => d.key === key)!;
    const none = buildColourReview(HASH, header, report, null);
    expect(by(none, ROAD)).toMatchObject({ choice: null, overridden: false });
    const plain = buildColourReview(HASH, header, report, { order: "iof", deviations: {} });
    expect(by(plain, ROAD)).toMatchObject({ choice: "keep", overridden: false });
    expect(by(plain, PAVED_BUILDING)).toMatchObject({ choice: "drop", overridden: false });
    // A no-op override: the report says "implied", the setting says overridden.
    const noop = buildColourReview(HASH, header, report, { order: "iof", deviations: { [BUILDING]: "keep" } });
    expect(by(noop, BUILDING)).toMatchObject({ why: "implied", kept: true, choice: "keep", overridden: true });
  });

  it("carries the map's overrides in a source document's IOF picture URL only", async () => {
    const iof = await imported("colour-layers.ocd");
    const source = await imported("colour-layers.ocd", { colourOrder: "source" });
    const setting = { order: "source" as const, deviations: { [ROAD]: "drop" as const, [PAVED_BUILDING]: "keep" as const } };
    const q = encodeURIComponent(`${PAVED_BUILDING}:keep,${ROAD}:drop`);
    expect(buildColourReview(HASH, source.header, source.report, setting).pictures).toEqual({
      iof: `/api/map-documents/${HASH}/colour-order/iof.png?deviations=${q}`,
      source: `/api/map-documents/${HASH}/colour-order/source.png`,
    });
    expect(buildColourReview(HASH, source.header, source.report, { order: "source", deviations: {} }).pictures.iof).toBe(`/api/map-documents/${HASH}/colour-order/iof.png`);
    expect(buildColourReview(HASH, iof.header, iof.report, { order: "iof", deviations: { [ROAD]: "drop" } }).pictures.iof).toBe(`/api/map-documents/${HASH}/colour-order/iof.png`);
  });

  it("parses the colour-order route's file name: the picture or the document (row I8a)", () => {
    expect(parseColourOrderFile("iof.png")).toEqual({ order: "iof", format: "png" });
    expect(parseColourOrderFile("source.json")).toEqual({ order: "source", format: "json" });
    for (const bad of ["iof", "mapper.json", "iof.jpg", ".json", "iof.png.json", "IOF.png"]) expect(parseColourOrderFile(bad)).toBeNull();
  });

  it("parses the picture's deviations query and keys the picture by it", () => {
    expect(parsePictureDeviations(undefined)).toEqual({});
    expect(parsePictureDeviations(`${ROAD}:drop,${YELLOW}:keep,${PAVED_BUILDING}:drop`)).toEqual({ [ROAD]: "drop", [YELLOW]: "keep" });
    expect(parsePictureDeviations("nonsense")).toBeNull();
    expect(parsePictureDeviations(`${ROAD}:maybe`)).toBeNull();
    expect(pictureDeviationsQuery({ [YELLOW]: "keep", [ROAD]: "drop" })).toBe(`${ROAD}:drop,${YELLOW}:keep`);
    expect(colourPictureKey("iof")).toBe("iof");
    expect(colourPictureKey("iof", { [ROAD]: "keep" })).toBe("iof");
    expect(colourPictureKey("source", { [ROAD]: "drop" })).toBe("source");
    const k = colourPictureKey("iof", { [ROAD]: "drop" });
    expect(k).toMatch(/^iof-[0-9a-f]{16}$/);
    expect(colourPictureKey("iof", { [YELLOW]: "keep" })).not.toBe(k);
  });
});

describe("the colour panel's payload", () => {
  it("lists the layers of e2e/colour-layers.ocd in draw order with colour, role and flags", async () => {
    const { header, report } = await imported("colour-layers.ocd");
    const v = buildColourReview(HASH, header, report, { order: "iof", deviations: {} });
    expect(v.order).toBe("iof");
    expect(v.fallback).toBe(false);
    expect(v.setting).toEqual({ order: "iof", deviations: {} });
    expect(v.pictures).toEqual({ iof: colourPictureUrl(HASH, "iof"), source: colourPictureUrl(HASH, "source") });
    expect(v.pictures.iof).toBe(`/api/map-documents/${HASH}/colour-order/iof.png`);
    const layers = v.layers!;
    expect(layers).toHaveLength(13);
    expect(layers.map((l) => l.row)).toEqual([...layers.keys()]);
    expect(layers.at(-1)!.role).toBe("purple-upper");
    // The split brown 50 %: two rows, same ink, the map's name, both flagged.
    const split = layers.filter((l) => l.flags.includes("split"));
    expect(split.map((l) => l.role)).toEqual(["brown50-paved", "brown50-road"]);
    expect(new Set(split.map((l) => l.hex)).size).toBe(1);
    expect(split.every((l) => l.name === "Brown 50%")).toBe(true);
    const paved = layers.find((l) => l.role === "brown50-paved")!;
    expect(paved.roleName).toBe(roleName("brown50-paved"));
    expect(paved.roleName).not.toBe("brown50-paved");
    expect(paved.objects).toBe(1);
    expect(paved.flags).toEqual(expect.arrayContaining(["deviation-kept", "deviation-dropped"]));
    const inserted = layers.find((l) => l.role === "purple-lower")!;
    expect(inserted.origin).toBe("insert");
    expect(inserted.sourceNumber).toBeNull();
    expect(inserted.flags).toEqual([]);
  });

  it("lists every deviation of e2e/colour-layers.ocd, kept or dropped, with its default", async () => {
    const { header, report } = await imported("colour-layers.ocd");
    const d = buildColourReview(HASH, header, report, null).deviations;
    expect(d).toHaveLength(9);
    expect(d.filter((x) => x.kept)).toHaveLength(3);
    const by = (key: string) => d.find((x) => x.key === key)!;
    expect(by("brown50-paved>brown100-line")).toMatchObject({ kept: true, default: "keep", why: "default" });
    expect(by(ROAD)).toMatchObject({ kept: true, default: "keep", why: "default" });
    expect(by("black50-building>brown100-line")).toMatchObject({ kept: true, default: "drop", why: "implied", impliedBy: ["brown50-paved>brown100-line"] });
    expect(by("brown50-paved>black50-building")).toMatchObject({ kept: false, default: "drop", why: "default" });
    expect(by(ROAD).upperName).toBe(roleName("brown50-road"));
  });

  it("names an override and a blocked deviation", async () => {
    const { header, report } = await imported("colour-layers.ocd", { deviations: { [ROAD]: "drop" } });
    const d = buildColourReview(HASH, header, report, null).deviations;
    expect(d.find((x) => x.key === ROAD)).toMatchObject({ kept: false, default: "keep", why: "override" });
    const blocked = buildColourReview(HASH, header, { colourStack: { order: "iof", layers: { rows: [], split: [], sourceOrdered: [], noRole: [], deviations: [{ upper: "a", lower: "b", kept: false, byDefault: false, objects: { upper: 1, lower: 1 }, blockedBy: ["c"] }], purpleInk: null } } }, null).deviations;
    expect(blocked[0]).toMatchObject({ why: "blocked", blockedBy: ["c"], kept: false });
  });

  it("leaves the split flag off a draws-nothing identified row and flags the library-drawn reference (e2e/test.ocd)", async () => {
    const { header, report } = await imported("test.ocd");
    const v = buildColourReview(HASH, header, report, null);
    const layers = v.layers!;
    expect(layers.some((l) => l.flags.includes("split"))).toBe(false);
    const identified = layers.find((l) => l.origin === "identified")!;
    expect(identified.role).toBe("white-over-green-brown");
    // Row 0: a roleless reference no object is drawn in, named by its place.
    expect(layers[0]).toMatchObject({ role: null, roleName: null, place: "other", objects: 0, symbols: 1 });
    expect(layers[0].flags).toEqual(expect.arrayContaining(["no-role", "source-ordered", "draws-nothing"]));
    expect(v.deviations).toHaveLength(3);
    expect(v.deviations.every((x) => !x.kept)).toBe(true);
  });

  it("flags a colour split only by place on both rows and names them by place (carried from I3)", () => {
    const row = (r: number, place: "area" | "other") => ({ row: r, source: 7, role: null, place, origin: "use", objects: 2, symbols: 1, graphicObjects: 0, sourceOrdered: "no-role", ownOrder: false });
    const report = {
      colourStack: {
        order: "iof",
        layers: { rows: [row(0, "area"), row(1, "other")], split: [{ source: 7, sourceNumber: 7, roles: [null, null] }], sourceOrdered: [], noRole: [], deviations: [], purpleInk: null },
      },
    };
    const colours = [0, 1].map((i) => ({ id: i ? "src:7/none:other" : "src:7", name: "Red", cmyk: [0, 100, 100, 0] as [number, number, number, number], sourceNumber: 7 }));
    const layers = buildColourReview(HASH, { colours }, report, null).layers!;
    expect(layers.map((l) => [l.place, l.role, l.flags.includes("split"), l.flags.includes("no-role")])).toEqual([
      ["area", null, true, true],
      ["other", null, true, true],
    ]);
  });

  it("has no layers in the map's own order", async () => {
    const { header, report } = await imported("colour-layers.ocd", { colourOrder: "source" });
    const v = buildColourReview(HASH, header, report, { order: "source", deviations: {} });
    expect(v.order).toBe("source");
    expect(v.layers).toBeNull();
    expect(v.deviations).toEqual([]);
    expect(v.built).toEqual({ order: "source", deviations: {} });
  });
});
