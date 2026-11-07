import { describe, expect, it } from "vitest";
import { symbolLibrary, type mapDocument } from "@oxygen/shared";
import { filterGroups, groupOfSymbol, groupState, swatchUrl, symbolGroups, toggleGroup } from "../symbol-groups";

type Sym = mapDocument.DocumentSymbol;

const sym = (code: string, name: string, over: Partial<Sym> = {}): Sym => ({
  code, name, kind: "line", origin: "source", hidden: false, render: { type: "line", id: code, code, name, main: { colour: 0, widthUm: 300 } }, ...over,
} as Sym);
const applied = (canonicalId: string, state: "auto" | "suggested" = "auto", reviewed = false): Sym["match"] => ({
  canonicalId, method: "code+geometry", state, confidence: 0.9, reasons: [], reviewed, libraryVersion: "x",
});

/** Shaped like the E2E fixture (`test.ocd`) plus the clutter the user saw: variants, frames, helpers. */
const header = {
  library: { id: "ISOM2017-2", version: "x" },
  symbols: [
    /* 0 */ sym("505.0", "Path", { match: applied("ISOM2017-2:202", "suggested") }),
    /* 1 */ sym("601.0", "Magnetic north line", { match: applied("ISOM2017-2:601.b") }),
    /* 2 */ sym("601.1", "Magnetic north line, blue", { match: applied("ISOM2017-2:601") }),
    /* 3 */ sym("850.1", "Frame", { kind: "rectangle" }),
    /* 4 */ sym("101.0", "Contour", { match: applied("ISOM2017-2:101", "suggested", true) }),
    /* 5 */ sym("101.1", "Contour, min. size"),
    /* 6 */ sym("999.0", "Helper", { hidden: true }),
    /* 7 */ sym("402.0", "Unused open land"),
    /* 8 */ sym("graphic", "Graphic line", { origin: "graphic" }),
    /* 9 */ sym("207.0", "Missing", { origin: "missing", render: null }),
    /* 10 */ sym("520.0", "Forbidden area", { kind: "area", render: null }),
  ],
} as Pick<mapDocument.MapDocumentHeader, "symbols" | "library">;
const objects = [3, 2, 1, 1, 9, 4, 5, 0, 1, 2, 1];

describe("filter-region symbol groups (docs/course-editor.md §7, filter region)", () => {
  const groups = symbolGroups(header, objects, "en");
  const by = (code: string) => groups.find((g) => g.code === code);

  it("one entry per heading: an applied match's heading, else the source base code", () => {
    // 601.b and 601 are one heading; 101.1 (no match) joins 101 by its base code.
    expect(by("601")?.members).toEqual([1, 2]);
    expect(by("101")?.members).toEqual([4, 5]);
    // A suggested match is not applied: 505 stays the source's 505, named by the source.
    expect(by("505")).toMatchObject({ members: [0], name: "Path", library: true, other: false });
  });

  it("an applied heading is named from the library in the UI language", () => {
    expect(by("601")?.name).toBe("Magnetic north line");
    expect(symbolGroups(header, objects, "sv").find((g) => g.code === "601")?.name).toBe("Magnetisk nordlinje");
    expect(symbolGroups(header, objects, "sv-SE").find((g) => g.code === "601")?.name).toBe("Magnetisk nordlinje");
  });

  it("hidden, unused, missing and proxy-drawn symbols are not listed", () => {
    const listed = groups.flatMap((g) => g.members);
    for (const i of [6, 7, 9, 10]) expect(listed).not.toContain(i);
  });

  it("frames, graphics and codes outside the library fold under Other, after the library headings in code order", () => {
    expect(groups.map((g) => g.code)).toEqual(["101", "505", "601", "850", "graphic"]);
    expect(groups.filter((g) => g.other).map((g) => g.code)).toEqual(["850", "graphic"]);
  });

  it("swatches: the library entry for an applied heading (its most used member), else the document symbol", () => {
    expect(by("601")?.swatch).toEqual({ kind: "library", canonicalId: "ISOM2017-2:601.b" });
    expect(by("505")?.swatch).toEqual({ kind: "document", idx: 0 });
  });

  it("search matches the heading, the library names and the members' source codes and names", () => {
    expect(filterGroups(groups, "path").map((g) => g.code)).toEqual(["505"]);
    expect(filterGroups(groups, "magnetisk").map((g) => g.code)).toEqual(["601"]);
    expect(filterGroups(groups, "min. size").map((g) => g.code)).toEqual(["101"]);
    expect(filterGroups(groups, "601.1").map((g) => g.code)).toEqual(["601"]);
    expect(filterGroups(groups, "frame").map((g) => g.code)).toEqual(["850"]);
    expect(filterGroups(groups, "")).toBe(groups);
  });

  it("a group is checked when all its members are picked, partial when some", () => {
    const g = by("601")!;
    expect(groupState(g, new Set([1, 2, 7]))).toBe("all");
    expect(groupState(g, new Set([2]))).toBe("some");
    expect(groupState(g, new Set([0]))).toBe("none");
  });

  it("toggling writes every member: a partial or empty group is completed, a full one removed", () => {
    const g = by("601")!;
    expect(toggleGroup([5, 2], g)).toEqual([1, 2, 5]);
    expect(toggleGroup([], g)).toEqual([1, 2]);
    expect(toggleGroup([1, 2, 5], g)).toEqual([5]);
  });

  it("finds the group of a document symbol (the eyedropper's hit)", () => {
    expect(groupOfSymbol(groups, 5)?.code).toBe("101");
    expect(groupOfSymbol(groups, 6)).toBeNull();
  });

  it("swatch images: the versioned library preview, or the document symbol's preview scoped to the event", () => {
    expect(swatchUrl({ kind: "library", canonicalId: "ISOM2017-2:601.b" }, "ab", "ev")).toBe(`/api/library/ISOM2017-2/${symbolLibrary.SYMBOL_LIBRARY_VERSION}/601.b.png`);
    expect(swatchUrl({ kind: "document", idx: 3 }, "ab", "ev")).toBe("/api/map-documents/ab/symbols/3.png?event=ev");
    expect(swatchUrl(null, "ab", "ev")).toBeNull();
  });
});
