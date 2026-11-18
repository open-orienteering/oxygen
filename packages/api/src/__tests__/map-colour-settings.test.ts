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
  defaultDeviationChoice,
  matchColourOptions,
  normaliseColourSettings,
  parseColourSettings,
  reportFollowsColour,
  sameColourSettings,
} from "../map-store/colour-settings.js";
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

  it("has no layers in the map's own order", async () => {
    const { header, report } = await imported("colour-layers.ocd", { colourOrder: "source" });
    const v = buildColourReview(HASH, header, report, { order: "source", deviations: {} });
    expect(v.order).toBe("source");
    expect(v.layers).toBeNull();
    expect(v.deviations).toEqual([]);
    expect(v.built).toEqual({ order: "source", deviations: {} });
  });
});
