import { describe, expect, it } from "vitest";
import { formatBytes, mapInfoRows, type MapInfoHeader, type MapInfoInput } from "../map-info";

/** A stand-in `t` that shows the key and its options, so the rows' wording is checked by key. */
const t = (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key);
const day = (iso: string) => iso.slice(0, 10);

const header: MapInfoHeader = {
  format: { version: 1, importer: "ocad-16" },
  source: { kind: "ocad", version: "12.0.4", hash: "a".repeat(64), bytes: 2_500_000 },
  library: { id: "isom-2017-2", version: "1.4" },
  georeferencing: { crs: { authority: "EPSG", code: 3006, name: "SWEREF99 TM" }, paperOrigin: null, gridRotationDeg: 0, gridScaleFactor: 1 },
  colours: Array.from({ length: 3 }, () => ({}) as MapInfoHeader["colours"][number]),
  symbols: Array.from({ length: 2 }, () => ({}) as MapInfoHeader["symbols"][number]),
  objects: { count: 1234, sections: { attrs: { offset: 0, length: 0 }, bboxes: { offset: 0, length: 0 }, geometry: { offset: 0, length: 0 } } },
};

const full: MapInfoInput = {
  fileName: "Skogen.ocd",
  uploadedAt: "2026-11-07T08:30:00.000Z",
  sizeBytes: 2_500_000,
  scale: 10000,
  meridianStalenessDeg: 0.4,
  documentHash: "b".repeat(64),
  header,
};

describe("the map-info dialog's rows (docs/course-editor.md §2, P6)", () => {
  it("a map with its document: name, scale, file; then source, content, library, CRS, importer", () => {
    const info = mapInfoRows(full, t, day);
    expect(info.map.map((r) => r.id)).toEqual(["name", "scale", "file"]);
    expect(info.map[0]).toMatchObject({ label: "mapInfoName", text: "Skogen.ocd", data: { name: "Skogen.ocd" } });
    expect(info.map[1]).toMatchObject({ label: "mapInfoScale", data: { scale: "10000" } });
    expect(info.map[1].text).toBe(`mapInfoScaleValue:${JSON.stringify({ scale: (10000).toLocaleString("sv-SE") })}`);
    expect(info.map[2]).toMatchObject({ text: `mapInfoFileValue:{"size":"2.4 MB","date":"2026-11-07"}`, data: { bytes: "2500000" } });
    expect(info.document.map((r) => r.id)).toEqual(["source", "content", "symbol-library", "crs", "importer"]);
    expect(info.document[0]).toMatchObject({ text: "OCAD 12.0.4", data: { kind: "ocad", version: "12.0.4" } });
    expect(info.document[1].text).toBe(`mapInfoObjects:{"count":1234} · mapInfoSymbols:{"count":2} · mapInfoColours:{"count":3}`);
    expect(info.document[2].text).toBe("isom-2017-2 · 1.4");
    expect(info.document[3]).toMatchObject({ text: "EPSG:3006 · SWEREF99 TM", data: { crs: "EPSG:3006" } });
    expect(info.document[4].text).toBe("ocad-16");
    expect(info.documentData).toEqual({ source: "ocad", objects: "1234", symbols: "2", colours: "3" });
  });

  it("while the document loads or the import runs: the map's rows only", () => {
    const info = mapInfoRows({ ...full, header: null, documentHash: null }, t, day);
    expect(info.map.map((r) => r.id)).toEqual(["name", "scale", "file"]);
    expect(info.document).toEqual([]);
    expect(info.documentData).toBeNull();
  });

  it("no library and no CRS: those rows are absent; an OOM source is named in full", () => {
    const info = mapInfoRows({ ...full, header: { ...header, library: null, georeferencing: { ...header.georeferencing, crs: null }, source: { ...header.source, kind: "omap", version: "" } } }, t, day);
    expect(info.document.map((r) => r.id)).toEqual(["source", "content", "importer"]);
    expect(info.document[0].text).toBe("OpenOrienteering Mapper");
  });

  it("no map: no rows", () => {
    const info = mapInfoRows({ fileName: null, uploadedAt: null, sizeBytes: null, scale: null, meridianStalenessDeg: null, documentHash: null, header: null }, t, day);
    expect(info).toEqual({ map: [], document: [], documentData: null });
  });

  it("an unknown size shows the upload date alone", () => {
    expect(mapInfoRows({ ...full, sizeBytes: 0 }, t, day).map[2].text).toBe("2026-11-07");
  });

  it("bytes as the club-map picker shows them", () => {
    expect(formatBytes(512 * 1024)).toBe("512.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(40 * 1024 * 1024)).toBe("40.0 MB");
  });
});
