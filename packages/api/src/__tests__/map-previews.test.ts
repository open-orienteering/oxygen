/**
 * Pure parts of the preview routes and the library preview cache
 * (docs/map-storage.md §4.4). Rows and the routes themselves are in the
 * integration suite.
 */
import { afterEach, describe, expect, it } from "vitest";
import { symbolLibrary } from "@oxygen/shared";
import {
  LIBRARY_CACHE_ENTRIES,
  LIBRARY_CODE,
  libraryPreviewCacheSize,
  libraryPreviewEtag,
  libraryPreviewPng,
  parseSymbolIdx,
  previewEtag,
  resetLibraryPreviewCache,
  stripPng,
} from "../map-store/previews.js";
import { matchesEtag, parseDocumentHash } from "../map-store/routes.js";

const V = symbolLibrary.SYMBOL_LIBRARY_VERSION;

afterEach(() => resetLibraryPreviewCache());

describe("preview request parsing", () => {
  it("symbol index: non-negative integers only", () => {
    expect(parseSymbolIdx("0")).toBe(0);
    expect(parseSymbolIdx("17")).toBe(17);
    for (const bad of ["", "-1", "01", "1.5", "1e3", "abc", " 1", "9999999"]) expect(parseSymbolIdx(bad), bad).toBeNull();
  });

  it(".png suffix is required", () => {
    expect(stripPng("418.png")).toBe("418");
    expect(stripPng("302.b.png")).toBe("302.b");
    expect(stripPng("418")).toBeNull();
    expect(stripPng("418.svg")).toBeNull();
  });

  it("library code: entry id without the library prefix", () => {
    for (const ok of ["418", "302.b", "505.1", "520.12", "115.1.b"]) expect(LIBRARY_CODE.test(ok), ok).toBe(true);
    for (const bad of ["41", "4180", "302.B", "302.bc", "302.", "../x", "418.png"]) expect(LIBRARY_CODE.test(bad), bad).toBe(false);
  });

  it("document hash: 64 hex, upper case folded", () => {
    const h = "A".repeat(64);
    expect(parseDocumentHash(h)).toBe("a".repeat(64));
    expect(parseDocumentHash("a".repeat(63))).toBeNull();
    expect(parseDocumentHash("g".repeat(64))).toBeNull();
  });

  it("ETags name the content and match If-None-Match like the document route", () => {
    const h = "a".repeat(64);
    expect(previewEtag(h, "thumbnail", "")).toBe(`"${h}/thumbnail"`);
    expect(previewEtag(h, "symbol", "3")).toBe(`"${h}/symbols/3"`);
    expect(libraryPreviewEtag("ISOM2017-2", V, "418")).toBe(`"ISOM2017-2@${V}/418"`);
    const e = previewEtag(h, "symbol", "3");
    expect(matchesEtag(`W/${e}`, e)).toBe(true);
    expect(matchesEtag(`"x", ${e}`, e)).toBe(true);
    expect(matchesEtag(previewEtag(h, "symbol", "4"), e)).toBe(false);
  });
});

describe("libraryPreviewPng", () => {
  it("renders an entry and its variant, 404 (null) for an unknown code or another version", async () => {
    const png = await libraryPreviewPng("ISOM2017-2", V, "418");
    expect(png?.subarray(1, 4).toString()).toBe("PNG");
    const variant = symbolLibrary.getSymbolLibrary("ISOM2017-2").entries.find((e) => e.variant !== null)!;
    expect(await libraryPreviewPng("ISOM2017-2", V, variant.id.split(":")[1])).not.toBeNull();
    expect(await libraryPreviewPng("ISOM2017-2", V, "999")).toBeNull();
    expect(await libraryPreviewPng("ISOM2017-2", "2000.1.1", "418")).toBeNull();
  });

  it("caches per instance: a second request returns the same buffer", async () => {
    const a = await libraryPreviewPng("ISSprOM2019-2", V, "521");
    const b = await libraryPreviewPng("ISSprOM2019-2", V, "521");
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(libraryPreviewCacheSize()).toBe(1);
    expect(LIBRARY_CACHE_ENTRIES).toBeGreaterThanOrEqual(symbolLibrary.listSymbolLibraries().reduce((n, l) => n + l.entries.length, 0));
  });
});
