/**
 * Behavioral tests for `livelox.importClass`.
 *
 * The router fans out to three pieces:
 *   - `fetchClassInfo(classId)` → ClassBlobUrl + names
 *   - `fetchClassBlob(url)`     → the full Livelox blob
 *   - `transformToReplayData()` → wire-level ReplayData
 *
 * We stub the two `fetch*` calls so the test is hermetic, then assert
 * the router:
 *   1. Returns a valid `ReplayData` with `sourceType: "livelox"` and
 *      the eventName + className threaded through.
 *   2. Rewrites map tile URLs through `/api/livelox-tile?url=…` so the
 *      browser doesn't get CORS-blocked.
 *   3. Wraps upstream errors in `TRPCError(PRECONDITION_FAILED)` with
 *      the upstream message preserved, so the frontend's "Failed to
 *      load map" fallback shows the real reason.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import type { LiveloxClassBlob } from "../livelox/fetcher.js";

vi.mock("../livelox/fetcher.js", () => ({
  fetchClassInfo: vi.fn(),
  fetchClassBlob: vi.fn(),
}));

import { fetchClassInfo, fetchClassBlob } from "../livelox/fetcher.js";
import { liveloxRouter } from "../routers/livelox.js";

const fetchClassInfoMock = vi.mocked(fetchClassInfo);
const fetchClassBlobMock = vi.mocked(fetchClassBlob);

function makeBlob(): LiveloxClassBlob {
  // Minimal but realistic shape — enough that `transformToReplayData`
  // produces a non-empty map + course + at least one route.
  return {
    map: {
      url: "https://livelox.azureedge.net/maps/map.png",
      width: 1000,
      height: 800,
      rotation: 0,
      mapScale: 10000,
      boundingBox: {
        south: 59.31,
        north: 59.33,
        west: 18.05,
        east: 18.08,
        center: { latitude: 59.32, longitude: 18.065 },
      },
      defaultProjection: {
        matrix: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        origin: { latitude: 59.32, longitude: 18.065 },
      },
      images: [],
    },
    tileData: {
      mapTileInfo: {
        mapTiles: [
          {
            x: 0,
            y: 0,
            width: 256,
            height: 256,
            url: "https://livelox.azureedge.net/tiles/0_0.png",
          },
        ],
        imageInfo: {
          width: 1000,
          height: 800,
          defaultProjection: {
            matrix: [
              [1, 0, 0],
              [0, 1, 0],
              [0, 0, 1],
            ],
            origin: { latitude: 59.32, longitude: 18.065 },
          },
          resolution: 1,
        },
      },
      imageFormat: "png",
    },
    courses: [
      {
        id: 1,
        name: "H21",
        length: 5000,
        controls: [
          {
            control: {
              numericCode: 31,
              type: 0,
              position: { latitude: 59.32, longitude: 18.065 },
              code: "Start",
            },
          },
          {
            control: {
              numericCode: 32,
              type: 1,
              position: { latitude: 59.321, longitude: 18.066 },
              code: "32",
            },
          },
          {
            control: {
              numericCode: 33,
              type: 2,
              position: { latitude: 59.322, longitude: 18.067 },
              code: "Finish",
            },
          },
        ],
      },
    ],
    participants: [],
    createdTime: "2026-04-15T08:00:00Z",
  };
}

beforeEach(() => {
  fetchClassInfoMock.mockReset();
  fetchClassBlobMock.mockReset();
});

describe("livelox.importClass", () => {
  it("returns a ReplayData with the upstream event + class names and source 'livelox'", async () => {
    fetchClassInfoMock.mockResolvedValue({
      classBlobUrl: "https://livelox.azureedge.net/blobs/abc.json",
      eventName: "Bagissprinten",
      className: "H21",
    });
    fetchClassBlobMock.mockResolvedValue(makeBlob());

    const caller = liveloxRouter.createCaller({} as never);
    const data = await caller.importClass({ classId: 12345 });

    expect(data.sourceType).toBe("livelox");
    expect(data.title).toBe("Bagissprinten — H21");
    expect(data.courses).toHaveLength(1);
    expect(data.courses[0].controls).toHaveLength(3);
    expect(data.map.tiles).toHaveLength(1);
  });

  it("rewrites all tile URLs through the /api/livelox-tile proxy", async () => {
    fetchClassInfoMock.mockResolvedValue({
      classBlobUrl: "https://livelox.azureedge.net/blobs/abc.json",
      eventName: "E",
      className: "C",
    });
    fetchClassBlobMock.mockResolvedValue(makeBlob());

    const caller = liveloxRouter.createCaller({} as never);
    const data = await caller.importClass({ classId: 12345 });

    for (const tile of data.map.tiles) {
      expect(tile.url).toMatch(/^\/api\/livelox-tile\?url=/);
      // The proxied target must be encoded inside `url=…` — the page
      // wouldn't render correctly if the original URL leaked through.
      expect(tile.url).toContain(
        encodeURIComponent("https://livelox.azureedge.net/tiles/0_0.png"),
      );
    }
  });

  it("preserves the upstream error message inside TRPCError(PRECONDITION_FAILED)", async () => {
    fetchClassInfoMock.mockRejectedValue(
      new Error("Livelox ClassInfo request failed: 404"),
    );

    const caller = liveloxRouter.createCaller({} as never);
    await expect(
      caller.importClass({ classId: 999_999 }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Livelox ClassInfo request failed: 404",
    });
  });

  it("wraps blob-fetch failures the same way (post-ClassInfo, pre-decode)", async () => {
    fetchClassInfoMock.mockResolvedValue({
      classBlobUrl: "https://livelox.azureedge.net/blobs/abc.json",
      eventName: "E",
      className: "C",
    });
    fetchClassBlobMock.mockRejectedValue(
      new Error("Livelox blob fetch failed: 503"),
    );

    const caller = liveloxRouter.createCaller({} as never);
    await expect(
      caller.importClass({ classId: 12345 }),
    ).rejects.toBeInstanceOf(TRPCError);
  });
});
