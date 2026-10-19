/**
 * Club library rows built from the series (docs/map-storage.md §6.5):
 * which table each listed field comes from, and the series-level and
 * version-level ownership checks.
 */
import { describe, it, expect } from "vitest";
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
    legacy: {
      id: 42n,
      scale: 15000,
      bounds: { north: 2, south: 1, east: 2, west: 1 },
      northOffset: 0.3,
      northDetection: null,
    },
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

  it("falls back to the legacy scale when the header carries none", () => {
    const base = input();
    const row = projectClubMapRow(input({ version: { ...base.version!, document: { header: {} } } }));
    expect(row.scale).toBe(15000);
  });

  it("reads raster-path metadata from the linked legacy row", () => {
    const detection = { meridian: null, grid: null };
    const row = projectClubMapRow(input({ legacy: { ...input().legacy!, northDetection: detection } }));
    expect(row.bounds).toEqual({ north: 2, south: 1, east: 2, west: 1 });
    expect(row.northOffset).toBe(0.3);
    expect(row.northDetection).toEqual(detection);
    expect(row.meridianStalenessDeg).toBeNull();
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
      scale: 15000,
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
