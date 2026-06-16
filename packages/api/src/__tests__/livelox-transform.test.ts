import { describe, it, expect } from "vitest";
import {
  mapControlType,
  mapResultStatus,
  decodeSplitTimes,
  transformToReplayData,
  extractPunchedCodes,
  buildForkSeqs,
  matchFork,
} from "../livelox/transform.js";
import type { LiveloxClassBlob } from "../livelox/fetcher.js";

/** Minimal blob whose only interesting knob is `projectionEpsgCode`. */
function blobWithProjection(epsg?: number): LiveloxClassBlob {
  const proj = {
    matrix: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    origin: { latitude: 0, longitude: 0 },
  };
  return {
    map: {
      url: "",
      width: 100,
      height: 100,
      rotation: 0,
      boundingBox: {
        south: 0,
        north: 0,
        west: 0,
        east: 0,
        center: { latitude: 0, longitude: 0 },
      },
      defaultProjection: proj,
      images: [],
    },
    tileData: {
      mapTileInfo: {
        mapTiles: [],
        imageInfo: { width: 100, height: 100, defaultProjection: proj, resolution: 1 },
      },
      imageFormat: "png",
    },
    courses: [],
    participants: [],
    createdTime: "2026-04-15T08:00:00Z",
    projectionEpsgCode: epsg,
  } as unknown as LiveloxClassBlob;
}

const transformOpts = { eventName: "E", className: "C" };

describe("mapControlType", () => {
  it("maps 0 to start", () => {
    expect(mapControlType(0)).toBe("start");
  });

  it("maps 2 to finish", () => {
    expect(mapControlType(2)).toBe("finish");
  });

  it("maps 1 to control", () => {
    expect(mapControlType(1)).toBe("control");
  });

  it("maps unknown values to control", () => {
    expect(mapControlType(99)).toBe("control");
    expect(mapControlType(-1)).toBe("control");
  });
});

describe("mapResultStatus", () => {
  it("maps 0 to ok", () => expect(mapResultStatus(0)).toBe("ok"));
  it("maps 1 to mp", () => expect(mapResultStatus(1)).toBe("mp"));
  it("maps 2 to dnf", () => expect(mapResultStatus(2)).toBe("dnf"));
  it("maps 3 to dns", () => expect(mapResultStatus(3)).toBe("dns"));
  it("maps 4 to dq", () => expect(mapResultStatus(4)).toBe("dq"));
  it("maps unknown values to unknown", () => {
    expect(mapResultStatus(5)).toBe("unknown");
    expect(mapResultStatus(99)).toBe("unknown");
  });
});

describe("decodeSplitTimes", () => {
  const courseControls = [
    { code: "31", numericCode: 31 },
    { code: "32", numericCode: 32 },
    { code: "33", numericCode: 33 },
    { code: "100", numericCode: 100 }, // finish
  ];

  it("returns empty for null/undefined input", () => {
    const result = decodeSplitTimes(null as unknown as number[], courseControls);
    expect(result.splits).toEqual([]);
    expect(result.baseTimeMs).toBe(0);
  });

  it("returns empty for too-short input", () => {
    const result = decodeSplitTimes([1000], courseControls);
    expect(result.splits).toEqual([]);
    expect(result.baseTimeMs).toBe(0);
  });

  it("extracts baseTimeMs from first element", () => {
    const result = decodeSplitTimes([5000000, 0], courseControls);
    expect(result.baseTimeMs).toBe(5000000);
    expect(result.splits).toEqual([]);
  });

  it("decodes leg times as cumulative splits", () => {
    // [baseTime, startCode, leg1ms, ctrl1code, leg2ms, ctrl2code, leg3ms, finishCode]
    const result = decodeSplitTimes(
      [1000000, 0, 120000, 31, 90000, 32, 150000, 100],
      courseControls,
    );

    expect(result.baseTimeMs).toBe(1000000);
    expect(result.splits).toHaveLength(3);

    // First split: 120s cumulative
    expect(result.splits[0]).toEqual({ controlCode: "31", timeMs: 120000 });
    // Second split: 120s + 90s = 210s cumulative
    expect(result.splits[1]).toEqual({ controlCode: "32", timeMs: 210000 });
    // Third split (finish): 210s + 150s = 360s cumulative
    expect(result.splits[2]).toEqual({ controlCode: "100", timeMs: 360000 });
  });

  it("handles unknown control codes by stringifying", () => {
    const result = decodeSplitTimes(
      [1000000, 0, 60000, 999],
      courseControls,
    );
    expect(result.splits[0].controlCode).toBe("999");
  });

  it("handles odd-length data (last leg without control code)", () => {
    const result = decodeSplitTimes(
      [1000000, 0, 60000],
      courseControls,
    );
    expect(result.splits).toHaveLength(1);
    expect(result.splits[0].controlCode).toBe("?");
    expect(result.splits[0].timeMs).toBe(60000);
  });
});

// ─── Forked relay legs ──────────────────────────────────────

type Ctrl = LiveloxClassBlob["courses"][number]["controls"][number];

function ctrl(numericCode: number, type: number, code: string): Ctrl {
  return {
    control: {
      numericCode,
      type,
      position: { latitude: 60 + numericCode / 1000, longitude: 26 + numericCode / 1000 },
      code,
    },
  };
}

/**
 * Blob with two forks (A: 31-32-33, B: 31-99-33) that share start (200) and
 * finish (100). Runners punch a spectator control 500 that is in no course.
 */
function forkedBlob(): LiveloxClassBlob {
  const proj = {
    matrix: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    origin: { latitude: 0, longitude: 0 },
  };
  const map = {
    url: "",
    width: 100,
    height: 100,
    rotation: 0,
    boundingBox: { south: 0, north: 0, west: 0, east: 0, center: { latitude: 0, longitude: 0 } },
    defaultProjection: proj,
    images: [],
  };
  return {
    map,
    tileData: {
      mapTileInfo: {
        mapTiles: [],
        imageInfo: { width: 100, height: 100, defaultProjection: proj, resolution: 1 },
      },
      imageFormat: "png",
    },
    courses: [
      {
        id: 111,
        name: "FA",
        length: 1000,
        controls: [ctrl(200, 0, "S"), ctrl(31, 1, "31"), ctrl(32, 1, "32"), ctrl(33, 1, "33"), ctrl(100, 2, "100")],
      },
      {
        id: 222,
        name: "FB",
        length: 1100,
        controls: [ctrl(200, 0, "S"), ctrl(31, 1, "31"), ctrl(99, 1, "99"), ctrl(33, 1, "33"), ctrl(100, 2, "100")],
      },
    ],
    participants: [
      {
        id: 1,
        classId: 9,
        firstName: "Alpha",
        lastName: "A",
        routeData: "AAAA",
        result: {
          status: 0,
          // [base, startCode, leg, code, leg, code, ...]
          splitTimeData: [1_000_000, 200, 60000, 31, 60000, 32, 60000, 33, 60000, 100],
        },
      },
      {
        id: 2,
        classId: 9,
        firstName: "Bravo",
        lastName: "B",
        routeData: "AAAA",
        result: {
          status: 0,
          // Fork B, with a spectator control 500 punched before the finish.
          splitTimeData: [1_000_000, 200, 50000, 31, 50000, 99, 50000, 33, 10000, 500, 50000, 100],
        },
      },
      {
        id: 3,
        classId: 9,
        firstName: "Charlie",
        lastName: "C",
        routeData: "AAAA",
        result: {
          status: 2, // DNF — only punched 31, 32 (prefix of fork A)
          splitTimeData: [1_000_000, 200, 70000, 31, 70000, 32],
        },
      },
    ],
    createdTime: "2026-04-15T08:00:00Z",
  } as unknown as LiveloxClassBlob;
}

describe("extractPunchedCodes", () => {
  it("returns the control codes (finish included), skipping base + start", () => {
    expect(extractPunchedCodes([1_000_000, 200, 60000, 31, 60000, 32, 60000, 100]))
      .toEqual([31, 32, 100]);
  });

  it("returns empty for too-short data", () => {
    expect(extractPunchedCodes([1_000_000, 200])).toEqual([]);
  });
});

describe("buildForkSeqs", () => {
  it("excludes the start control and keeps the rest in order", () => {
    const seqs = buildForkSeqs(forkedBlob().courses);
    expect(seqs).toEqual([
      { id: "111", seq: [31, 32, 33, 100] },
      { id: "222", seq: [31, 99, 33, 100] },
    ]);
  });
});

describe("matchFork", () => {
  const forks = buildForkSeqs(forkedBlob().courses);
  const valid = new Set<number>([31, 32, 33, 99, 100]);

  it("matches an exact punched sequence", () => {
    expect(matchFork([31, 32, 33, 100], forks, valid)).toBe("111");
    expect(matchFork([31, 99, 33, 100], forks, valid)).toBe("222");
  });

  it("drops spectator codes not present in any fork before matching", () => {
    expect(matchFork([31, 99, 33, 500, 100], forks, valid)).toBe("222");
  });

  it("falls back to the best positional match for incomplete (DNF) punch lists", () => {
    expect(matchFork([31, 32], forks, valid)).toBe("111");
  });

  it("returns undefined when nothing plausibly matches", () => {
    expect(matchFork([], forks, valid)).toBeUndefined();
    expect(matchFork([7, 8, 9], forks, valid)).toBeUndefined();
  });
});

describe("transformToReplayData — forked relay", () => {
  it("assigns each runner the fork they ran (via courseId)", () => {
    const data = transformToReplayData(forkedBlob(), transformOpts);
    const byName = Object.fromEntries(data.routes.map((r) => [r.name, r]));
    expect(byName["Alpha A"].courseId).toBe("111");
    expect(byName["Bravo B"].courseId).toBe("222");
    expect(byName["Charlie C"].courseId).toBe("111"); // best-fit fallback
  });

  it("exposes every fork as a course with a stable id", () => {
    const data = transformToReplayData(forkedBlob(), transformOpts);
    expect(data.courses.map((c) => c.id)).toEqual(["111", "222"]);
    expect(data.courses.map((c) => c.name)).toEqual(["FA", "FB"]);
  });

  it("names split controls across all forks (global code map)", () => {
    const data = transformToReplayData(forkedBlob(), transformOpts);
    const bravo = data.routes.find((r) => r.name === "Bravo B")!;
    // Control 99 only exists in fork B; the global name map must still resolve it.
    expect(bravo.result?.splitTimes?.some((s) => s.controlCode === "99")).toBe(true);
  });

  it("does not set courseId for non-forked events (single course)", () => {
    const blob = forkedBlob();
    blob.courses = [blob.courses[0]]; // collapse to a single course
    const data = transformToReplayData(blob, transformOpts);
    expect(data.routes.every((r) => r.courseId === undefined)).toBe(true);
  });
});

describe("transformToReplayData — relay metadata", () => {
  const legs = [
    { leg: 1, name: "1", participantCount: 859 },
    { leg: 2, name: "2", participantCount: 791 },
  ];

  it("emits relay legs and the current leg when more than one leg", () => {
    const data = transformToReplayData(forkedBlob(), {
      ...transformOpts,
      relayLegs: legs,
      currentLeg: 2,
    });
    expect(data.relay?.legs).toHaveLength(2);
    expect(data.relay?.currentLeg).toBe(2);
  });

  it("omits relay metadata for a single-leg (non-relay) class", () => {
    const data = transformToReplayData(forkedBlob(), {
      ...transformOpts,
      relayLegs: [legs[0]],
    });
    expect(data.relay).toBeUndefined();
  });
});

describe("transformToReplayData — projection guard", () => {
  it("throws a clear error when the route projection is present but unsupported", () => {
    // EPSG:25833 (UTM 33N, Norway) is not in CRS_PARAMS. Before this guard the
    // transform silently mis-decoded easting/northing as lat/lng and blanked
    // the map; now it fails loudly so the page can show the reason.
    expect(() => transformToReplayData(blobWithProjection(25833), transformOpts))
      .toThrow(/EPSG:25833/);
  });

  it("mentions the supported projections in the error", () => {
    expect(() => transformToReplayData(blobWithProjection(25833), transformOpts))
      .toThrow(/3006[\s\S]*3067|3067[\s\S]*3006/);
  });

  it("does not throw for a supported projection (EPSG:3067, Finland)", () => {
    expect(() => transformToReplayData(blobWithProjection(3067), transformOpts))
      .not.toThrow();
  });

  it("does not throw when no projection code is present (lat/lng routes)", () => {
    expect(() => transformToReplayData(blobWithProjection(undefined), transformOpts))
      .not.toThrow();
  });
});
