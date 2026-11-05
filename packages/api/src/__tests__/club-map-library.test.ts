/**
 * Club library rows built from the series (docs/map-storage.md §6.5):
 * which table each listed field comes from, and the series-level and
 * version-level ownership checks.
 */
import { describe, it, expect } from "vitest";
import { mapGeo } from "@oxygen/shared";
import {
  canDownloadClubMapVersion,
  canRemoveClubMap,
  latestVersionOrRefuse,
  projectClubMapRow,
  type ClubMapRowInput,
} from "../club-map-library.js";

const DOC = "d".repeat(64);
const SRC = "s".repeat(64);
const created = new Date("2026-10-01T10:00:00Z");
const uploaded = new Date("2026-10-02T11:00:00Z");

function input(over: Partial<ClubMapRowInput> = {}): ClubMapRowInput {
  return {
    series: {
      id: "0192-series",
      name: "Hagaby",
      colourProfile: "isom",
      colourOverrides: { above: [3] },
      northLinesBelow: false,
      rotationCorrection: 1.5,
      createdBy: "creator",
      createdAt: created,
      creator: { email: "c@example", displayName: "Creator" },
    },
    version: {
      id: "0192-version",
      seq: 1,
      label: "hagaby-2024.ocd",
      sourceHash: SRC,
      documentHash: DOC,
      uploadedAt: uploaded,
      uploadedBy: "uploader",
      uploader: { email: "u@example", displayName: "Uploader" },
      source: { fileName: "first-name.ocd", sizeBytes: 1234 },
      document: { header: { mapScale: 10000 } },
    },
    versionCount: 1,
    job: null,
    legacy: { id: 42n },
    ...over,
  };
}

describe("projectClubMapRow", () => {
  it("takes identity and settings from the series, file facts from the version", () => {
    const row = projectClubMapRow(input());
    expect(row).toMatchObject({
      id: "0192-series",
      name: "Hagaby",
      colorProfile: "isom",
      colorOverrides: { above: [3] },
      northLinesBelow: false,
      rotationCorrection: 1.5,
      createdBy: "creator",
      createdAt: created.toISOString(),
      version: {
        id: "0192-version",
        seq: 1,
        label: "hagaby-2024.ocd",
        sourceHash: SRC,
        documentHash: DOC,
        uploadedAt: uploaded.toISOString(),
        uploadedBy: "uploader",
      },
      versionCount: 1,
      importJob: null,
      fileName: "hagaby-2024.ocd",
      sizeBytes: 1234,
      scale: 10000,
      uploadedAt: uploaded.toISOString(),
      uploadedBy: "uploader",
      uploader: { email: "u@example", displayName: "Uploader" },
      previewUrl: `/api/map-documents/${DOC}/thumbnail.png`,
    });
    expect(row).not.toHaveProperty("renderKey");
  });

  it("falls back to the source's file name when the version has no label", () => {
    const base = input();
    const row = projectClubMapRow(input({ version: { ...base.version!, label: "" } }));
    expect(row.fileName).toBe("first-name.ocd");
  });

  it("has no scale when the header carries none", () => {
    const base = input();
    const row = projectClubMapRow(input({ version: { ...base.version!, document: { header: {} } } }));
    expect(row.scale).toBeNull();
  });

  it("reads extent and north from the version's document under the series' correction", () => {
    // A SWEREF99 TM map 1:10 000 with a north-line cluster tilted 0.8°.
    const georeferencing = { crs: { authority: "EPSG", code: 3006, name: "" }, paperOrigin: { x: 687000, y: 6574000 }, gridRotationDeg: 0, gridScaleFactor: 1 };
    const bounds = { minX: -10_000, minY: -8_000, maxX: 10_000, maxY: 8_000 };
    const north = {
      meridian: { symbolIdx: 3, code: "601.0", count: 14, medianTiltDeg: 0.8, stddevDeg: 0.1 },
      paperNorthBearingDeg: 1.2,
      displayNorthOffsetDeg: 2,
      declaredGrivationDeg: 0,
      trueNorthFromGridDeg: -1.2,
      centerLat: 59.29,
      centerLng: 18.2,
      declinationDeg: 6.5,
      meridianStalenessDeg: 4.5,
      asOf: "2026-10-02T11:00:00.000Z",
    };
    const base = input();
    const row = projectClubMapRow(
      input({
        version: {
          ...base.version!,
          document: { header: { unitsPerMm: 100, mapScale: 10000, georeferencing, bounds }, report: { north } },
        },
      }),
    );
    const expected = mapGeo.mapFileMetadata({ unitsPerMm: 100, mapScale: 10000, georeferencing, correctionDeg: 1.5 }, bounds, 0.8);
    expect(row.bounds).toEqual(expected.bounds);
    expect(row.northOffset).toBeCloseTo(expected.northOffset!, 9);
    expect(row.northDetection).toEqual(north);
    expect(row.meridianStalenessDeg).not.toBeNull();
  });

  it("has no extent or north without a georeferenced document and a report", () => {
    const row = projectClubMapRow(input());
    expect(row).toMatchObject({ bounds: null, northOffset: null, northDetection: null, meridianStalenessDeg: null });
  });

  it("lists a series without a version with its import job and the job's source", () => {
    const row = projectClubMapRow(
      input({
        version: null,
        versionCount: 0,
        job: { id: "job", state: "failed", error: "unsupported", source: { fileName: "broken.ocd", sizeBytes: 16 } },
      }),
    );
    expect(row).toMatchObject({
      version: null,
      versionCount: 0,
      importJob: { id: "job", state: "failed", error: "unsupported" },
      fileName: "broken.ocd",
      sizeBytes: 16,
      scale: null,
      uploadedAt: created.toISOString(),
      uploadedBy: "creator",
      uploader: { email: "c@example", displayName: "Creator" },
      previewUrl: "/api/club-map-preview/42",
    });
  });

  it("reports nothing it does not have", () => {
    const row = projectClubMapRow(input({ version: null, versionCount: 0, job: null, legacy: null }));
    expect(row).toMatchObject({
      fileName: null,
      sizeBytes: null,
      scale: null,
      bounds: null,
      northOffset: null,
      northDetection: null,
      meridianStalenessDeg: null,
      previewUrl: null,
      importJob: null,
    });
  });

  it("drops the import job once a version exists", () => {
    const row = projectClubMapRow(
      input({ job: { id: "job", state: "done", error: null, source: { fileName: "x.ocd", sizeBytes: 1 } } }),
    );
    expect(row.importJob).toBeNull();
  });

  it("counts the version document's matches awaiting review from its import report (docs/map-symbols.md §8.7)", () => {
    const base = input();
    const matching = { symbols: { auto: 4, suggested: 6, unmatched: 0, variant: 0, reviewed: 1 } };
    const row = projectClubMapRow(input({ version: { ...base.version!, document: { header: {}, report: { matching } } } }));
    expect(row.review).toEqual({ suggested: 6, reviewed: 1 });
  });

  it("has no review counts without a matched document", () => {
    expect(projectClubMapRow(input()).review).toBeNull();
    expect(projectClubMapRow(input({ version: null })).review).toBeNull();
    const base = input();
    const odd = projectClubMapRow(input({ version: { ...base.version!, document: { header: {}, report: { matching: { symbols: { suggested: "6" } } } } } }));
    expect(odd.review).toBeNull();
  });
});

describe("ownership", () => {
  const user = { id: "u1", isAdmin: false };
  it("remove: series creator or admin; auth off allows", () => {
    expect(canRemoveClubMap({ authEnabled: false, user: null, createdBy: "x" })).toBe(true);
    expect(canRemoveClubMap({ authEnabled: true, user, createdBy: "u1" })).toBe(true);
    expect(canRemoveClubMap({ authEnabled: true, user: { id: "a", isAdmin: true }, createdBy: "u1" })).toBe(true);
    expect(canRemoveClubMap({ authEnabled: true, user, createdBy: "other" })).toBe(false);
    expect(canRemoveClubMap({ authEnabled: true, user, createdBy: null })).toBe(false);
    expect(canRemoveClubMap({ authEnabled: true, user: null, createdBy: null })).toBe(false);
  });

  it("download: version uploader or admin; auth off allows", () => {
    expect(canDownloadClubMapVersion({ authEnabled: false, user: null, uploadedBy: "x" })).toBe(true);
    expect(canDownloadClubMapVersion({ authEnabled: true, user, uploadedBy: "u1" })).toBe(true);
    expect(canDownloadClubMapVersion({ authEnabled: true, user, uploadedBy: "other" })).toBe(false);
    expect(canDownloadClubMapVersion({ authEnabled: true, user: { id: "a", isAdmin: true }, uploadedBy: null })).toBe(true);
  });
});

describe("latestVersionOrRefuse", () => {
  it("returns the version", () => {
    const v = { id: "v" };
    expect(latestVersionOrRefuse("Hagaby", v)).toBe(v);
  });

  it("refuses a series without a version with PRECONDITION_FAILED", () => {
    expect(() => latestVersionOrRefuse("Hagaby", null)).toThrowError(
      expect.objectContaining({ code: "PRECONDITION_FAILED" }),
    );
  });
});
