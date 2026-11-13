/** `parseGpx` (docs/map-gps-tracks.md §2). */
import { describe, expect, it } from "vitest";
import { GpxParseError, parseGpx, parseGpxTime } from "../gpx.js";
import { GPX_10, GPX_11_GARMIN, GPX_EMPTY_SEGMENT_AND_BAD_POINT, GPX_TRUNCATED, GPX_WAYPOINTS_ONLY, KML } from "./gpx-fixtures.js";

function code(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof GpxParseError) return e.code;
    throw e;
  }
  return undefined;
}

describe("parseGpx: GPX 1.1", () => {
  const f = parseGpx(GPX_11_GARMIN);

  it("reads the root's version and creator, counts the waypoint", () => {
    expect(f.version).toBe("1.1");
    expect(f.creator).toBe("Garmin Connect");
    expect(f.waypoints).toBe(1);
    expect(f.skippedPoints).toBe(0);
    expect(f.skippedSegments).toBe(0);
  });

  it("one track per segment, in file order, named after the trk", () => {
    expect(f.tracks.map((t) => [t.name, t.source, t.trackIndex, t.segmentIndex, t.points.lat.length])).toEqual([
      ["Morning ski", "trk", 0, 0, 3],
      ["Morning ski", "trk", 0, 1, 2],
    ]);
  });

  it("quantises lat / lng to 1e-7°, ele to 0.1 m, times to epoch ms UTC (offsets, fractions)", () => {
    const p = f.tracks[0].points;
    expect(p.lat).toEqual([593001000, 593002000, 593003000]);
    expect(p.lng).toEqual([181001000, 181002000, 181003000]);
    expect(p.ele).toEqual([31.4, 31.8, 32]);
    const t0 = Date.UTC(2026, 0, 17, 9, 12, 3);
    expect(p.time).toEqual([t0, t0 + 2500, t0 + 4000]); // 10:12:07+01:00 = 09:12:07Z
  });

  it("ignores extensions (a namespace-prefixed hr element) and keeps the point", () => {
    expect(f.tracks[0].points.lat).toHaveLength(3);
  });
});

describe("parseGpx: GPX 1.0", () => {
  const f = parseGpx(GPX_10);

  it("tracks and routes in file order, two waypoints counted", () => {
    expect(f.version).toBe("1.0");
    expect(f.waypoints).toBe(2);
    expect(f.tracks.map((t) => [t.name, t.source, t.trackIndex, t.segmentIndex])).toEqual([
      ["Planned loop", "rte", 0, 0],
      ["Logged", "trk", 0, 0],
      [null, "trk", 1, 0],
    ]);
  });

  it("a route is untimed; its elevation is kept per point", () => {
    const r = f.tracks[0].points;
    expect(r.time).toBeNull();
    expect(r.ele).toEqual([100, null]);
  });

  it("missing time on every point → a null column; missing elevation → a null column", () => {
    const t = f.tracks[2].points;
    expect(t.time).toBeNull();
    expect(t.ele).toBeNull();
    expect(f.tracks[1].points.time).toEqual([Date.UTC(2019, 1, 3, 10), Date.UTC(2019, 1, 3, 10, 0, 1)]);
  });
});

describe("parseGpx: several tracks and segments", () => {
  it("two trk with two trkseg each → four tracks in order", () => {
    const seg = (a: number) => `<trkseg><trkpt lat="${a}" lon="1"/><trkpt lat="${a + 0.001}" lon="1"/></trkseg>`;
    const doc = `<gpx version="1.1"><trk><name>A</name>${seg(1)}${seg(2)}</trk><trk>${seg(3)}<name>B</name>${seg(4)}</trk></gpx>`;
    const f = parseGpx(doc);
    expect(f.tracks.map((t) => [t.name, t.trackIndex, t.segmentIndex, t.points.lat[0]])).toEqual([
      ["A", 0, 0, 10000000],
      ["A", 0, 1, 20000000],
      ["B", 1, 0, 30000000],
      ["B", 1, 1, 40000000],
    ]);
  });

  it("a prefixed GPX namespace, a BOM and a CDATA name", () => {
    const doc = `﻿<g:gpx xmlns:g="http://www.topografix.com/GPX/1/1" version="1.1"><g:trk><g:name><![CDATA[Spår <1>]]></g:name><g:trkseg><g:trkpt lat="1" lon="2"><g:time>2026-01-01T00:00:00</g:time></g:trkpt><g:trkpt lat="1.5" lon="2"/></g:trkseg></g:trk></g:gpx>`;
    const f = parseGpx(doc);
    expect(f.tracks).toHaveLength(1);
    expect(f.tracks[0].name).toBe("Spår <1>");
    // A time with no zone is UTC, and a point without a time is null in a timed column.
    expect(f.tracks[0].points.time).toEqual([Date.UTC(2026, 0, 1), null]);
  });
});

describe("parseGpx: bad points and segments", () => {
  const f = parseGpx(GPX_EMPTY_SEGMENT_AND_BAD_POINT);

  it("skips points with unreadable or out-of-range coordinates, counts them", () => {
    expect(f.skippedPoints).toBe(2);
    expect(f.tracks).toHaveLength(1);
    expect(f.tracks[0].points.lat).toEqual([590000000, 590001000]);
  });

  it("an unreadable time or elevation is null for that point; the empty segment is counted", () => {
    expect(f.tracks[0].points.time).toBeNull();
    expect(f.tracks[0].points.ele).toBeNull();
    expect(f.skippedSegments).toBe(1);
  });

  it("a one-point segment is skipped and counted", () => {
    const f1 = parseGpx(`<gpx><trk><trkseg><trkpt lat="1" lon="1"/></trkseg><trkseg><trkpt lat="1" lon="1"/><trkpt lat="2" lon="1"/></trkseg></trk></gpx>`);
    expect(f1.skippedSegments).toBe(1);
    expect(f1.tracks.map((t) => t.segmentIndex)).toEqual([1]);
  });
});

describe("parseGpx: errors", () => {
  it("malformed XML → malformed, with the offset", () => {
    expect(code(() => parseGpx(GPX_TRUNCATED))).toBe("malformed");
    expect(code(() => parseGpx("<gpx><trk></gpx>"))).toBe("malformed");
    expect(code(() => parseGpx(""))).toBe("malformed");
    expect(code(() => parseGpx("not xml at all"))).toBe("malformed");
    try {
      parseGpx("<gpx><trk></gpx>");
    } catch (e) {
      expect((e as GpxParseError).offset).toBeTypeOf("number");
    }
  });

  it("another XML document → not-gpx", () => {
    expect(code(() => parseGpx(KML))).toBe("not-gpx");
  });

  it("waypoints only → no-points", () => {
    expect(code(() => parseGpx(GPX_WAYPOINTS_ONLY))).toBe("no-points");
  });
});

describe("parseGpxTime", () => {
  it.each([
    ["2026-01-17T09:12:03Z", Date.UTC(2026, 0, 17, 9, 12, 3)],
    ["2026-01-17T09:12:03.123456Z", Date.UTC(2026, 0, 17, 9, 12, 3, 123)],
    ["2026-01-17T09:12:03", Date.UTC(2026, 0, 17, 9, 12, 3)],
    ["2026-01-17T10:12:03+01:00", Date.UTC(2026, 0, 17, 9, 12, 3)],
    ["2026-01-17T04:12:03-0500", Date.UTC(2026, 0, 17, 9, 12, 3)],
    ["2026-01-17T11:12:03+02", Date.UTC(2026, 0, 17, 9, 12, 3)],
    [" 2026-01-17T09:12:03Z\n", Date.UTC(2026, 0, 17, 9, 12, 3)],
  ])("%s", (s, t) => {
    expect(parseGpxTime(s)).toBe(t);
  });

  it.each(["", "yesterday", "2026-01-17", "2026-13-01T00:00:00Z", "2026-01-17 09:12:03Z"])("rejects %j", (s) => {
    expect(parseGpxTime(s)).toBeNull();
  });
});

describe("parseGpx: scale", () => {
  it("streams 200 000 points", () => {
    const pts: string[] = [];
    for (let i = 0; i < 200_000; i++) pts.push(`<trkpt lat="${(59 + i * 1e-6).toFixed(7)}" lon="18.0000000"><ele>10</ele><time>2026-01-17T09:00:00Z</time></trkpt>`);
    const f = parseGpx(`<gpx version="1.1"><trk><trkseg>${pts.join("")}</trkseg></trk></gpx>`);
    expect(f.tracks[0].points.lat).toHaveLength(200_000);
    expect(f.tracks[0].points.lat[199_999]).toBe(quantise(59 + 199_999 * 1e-6));
  });
});

function quantise(deg: number): number {
  return Math.round(Number(deg.toFixed(7)) * 1e7);
}
