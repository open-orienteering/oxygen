/**
 * The symbol picker's view of the palette (docs/course-editor.md §13 "Symbol picker"; map-symbols.md §11.2).
 */

import { describe, expect, it } from "vitest";
import { mapDocument } from "@oxygen/shared";
import { findItem, itemKey, itemName, paletteSwatch, paletteView } from "../modes/map/palette";
import { symbolPut } from "../modes/map/symbols";
import { patchOf, pinnedDoc } from "./map-fixture";

const BOULDER = "ISOM2017-2:204";

describe("paletteView", () => {
  const pinned = pinnedDoc();
  const groups = mapDocument.mapPalette(pinned, null);

  it("keeps one kind; every heading and group without items of it is left out", () => {
    for (const kind of ["point", "line", "area"] as const) {
      const v = paletteView(groups, kind, "");
      expect(v.length).toBeGreaterThan(0);
      for (const g of v) {
        expect(g.headings.length).toBeGreaterThan(0);
        for (const h of g.headings) {
          expect(h.entries.length).toBeGreaterThan(0);
          expect(h.entries.every((e) => e.kind === kind)).toBe(true);
        }
      }
    }
  });

  it("searches the headings' text, trimmed and case-insensitive; no match leaves nothing", () => {
    const v = paletteView(groups, "point", "  BOULDER ");
    const codes = v.flatMap((g) => g.headings.map((h) => h.code));
    expect(codes).toContain("204");
    expect(codes.every((c) => groups.some((g) => g.headings.some((h) => h.code === c && h.search.includes("boulder"))))).toBe(true);
    expect(paletteView(groups, "point", "zzz-nothing")).toEqual([]);
  });

  it("the document's boulder is an enabled document item; the spring is a disabled library item naming its colour", () => {
    const points = paletteView(groups, "point", "");
    const doc = findItem(points, "doc:2")!;
    expect(doc).toMatchObject({ source: "document", enabled: true, code: "204.0" });
    expect(paletteSwatch(doc)).toEqual({ kind: "document", idx: 2 });
    const spring = findItem(points, "patch:ISOM2017-2:312")!;
    expect(spring).toMatchObject({ source: "library", enabled: false, missing: ["blue100-point"] });
    expect(paletteSwatch(spring)).toEqual({ kind: "library", canonicalId: "ISOM2017-2:312" });
    expect(findItem(points, "doc:99")).toBeNull();
    expect(findItem(points, null)).toBeNull();
  });

  it("a library item that became a patch symbol keeps its key, so the choice survives the first use", () => {
    const lib = findItem(paletteView(groups, "point", ""), `patch:${BOULDER}`);
    // The document's own 204 has no applied match, so the library's 204 is offered beside it.
    expect(lib?.source).toBe("library");
    const put = symbolPut(pinned, null, { patch: BOULDER });
    if (!put.ok) throw new Error("expected ok");
    const after = mapDocument.mapPalette(pinned, patchOf([], put.putSymbols));
    const item = findItem(paletteView(after, "point", ""), itemKey(lib!));
    expect(item?.source).toBe("patch");
    expect(item?.enabled).toBe(true);
  });

  it("names in Swedish when the UI is", () => {
    expect(itemName({ name: "Boulder", nameSv: "Sten" }, "sv-SE")).toBe("Sten");
    expect(itemName({ name: "Boulder", nameSv: "Sten" }, "en")).toBe("Boulder");
    expect(itemName({ name: "Boulder" }, "sv")).toBe("Boulder");
  });
});
