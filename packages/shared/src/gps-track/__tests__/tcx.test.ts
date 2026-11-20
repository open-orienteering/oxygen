/** `parseTcx` and `parseTrackFile` (docs/map-gps-tracks.md §2.4). */
import { describe, expect, it } from "vitest";
import { GpxParseError } from "../gpx.js";
import { parseTcx, parseTrackFile } from "../tcx.js";
import { GPX_11_GARMIN, KML } from "./gpx-fixtures.js";

const tp = (lat: number | string, lng: number | string, time?: string, ele?: number) => `
        <Trackpoint>
          ${time ? `<Time>${time}</Time>` : ""}
          <Position><LatitudeDegrees>${lat}</LatitudeDegrees><LongitudeDegrees>${lng}</LongitudeDegrees></Position>
          ${ele !== undefined ? `<AltitudeMeters>${ele}</AltitudeMeters>` : ""}
          <HeartRateBpm><Value>140</Value></HeartRateBpm>
          <Extensions><ns3:TPX><ns3:Speed>3.1</ns3:Speed></ns3:TPX></Extensions>
        </Trackpoint>`;

const ACTIVITY = `﻿<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
  <Activities>
    <Activity Sport="Running">
      <Id>2026-01-17T09:12:03Z</Id>
      <Lap StartTime="2026-01-17T09:12:03Z">
        <TotalTimeSeconds>300</TotalTimeSeconds>
        <Track>${tp(59.3001, 18.1001, "2026-01-17T09:12:03Z", 31.44)}${tp(59.3002, 18.1002, "2026-01-17T10:12:05.5+01:00", 31.8)}
          <Trackpoint><Time>2026-01-17T09:12:06Z</Time><HeartRateBpm><Value>141</Value></HeartRateBpm></Trackpoint>
        </Track>
      </Lap>
      <Lap StartTime="2026-01-17T09:17:03Z">
        <Track>${tp(59.3003, 18.1003, "2026-01-17T09:12:07")}${tp(91, 18.1, "2026-01-17T09:12:08Z")}</Track>
        <Track>${tp("5.93004e1", 18.1004, "2026-01-17T09:12:09Z")}</Track>
      </Lap>
      <Creator xsi:type="Device_t"><Name>Forerunner 965</Name></Creator>
    </Activity>
    <Activity Sport="Other"><Id>2026-01-18T08:00:00Z</Id><Lap><Track>${tp(59.4, 18.2)}</Track></Lap></Activity>
  </Activities>
  <Author><Name>Garmin Connect</Name></Author>
</TrainingCenterDatabase>`;

const COURSE = `<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Courses><Course><Name> Long ski </Name>
    <Track>${tp(60, 15, "2026-01-01T00:00:00Z", 200)}${tp(60.001, 15.001, "2026-01-01T00:01:00Z")}</Track>
    <CoursePoint><Name>Water</Name><Position><LatitudeDegrees>60</LatitudeDegrees><LongitudeDegrees>15</LongitudeDegrees></Position></CoursePoint>
  </Course></Courses>
</TrainingCenterDatabase>`;

function code(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof GpxParseError) return e.code;
    throw e;
  }
  return undefined;
}

describe("parseTcx: an activity", () => {
  const f = parseTcx(ACTIVITY);
  it("one timed track per Activity, every lap's Tracks joined; a short activity is a skipped segment", () => {
    expect(f.tracks.map((t) => [t.name, t.source, t.trackIndex, t.segmentIndex, t.points.lat.length])).toEqual([[null, "trk", 0, 0, 4]]);
    expect(f.skippedSegments).toBe(1);
    expect(f.creator).toBe("Forerunner 965");
    expect(f.version).toBeNull();
  });
  it("positions, elevations and times as GPX's; a position-less sample is no point, a bad position is skipped", () => {
    const p = f.tracks[0].points;
    expect(p.lat).toEqual([593001000, 593002000, 593003000, 593004000]);
    expect(p.lng).toEqual([181001000, 181002000, 181003000, 181004000]);
    expect(p.ele).toEqual([31.4, 31.8, null, null]);
    const t0 = Date.UTC(2026, 0, 17, 9, 12, 3);
    expect(p.time).toEqual([t0, t0 + 2500, t0 + 4000, t0 + 6000]);
    expect(f.skippedPoints).toBe(1);
  });
});

describe("parseTcx: a course", () => {
  it("one untimed track per Course, named; course points count as waypoints", () => {
    const f = parseTcx(COURSE);
    expect(f.tracks.map((t) => [t.name, t.source, t.trackIndex, t.points.lat.length])).toEqual([["Long ski", "rte", 0, 2]]);
    expect(f.tracks[0].points.time).toBeNull();
    expect(f.tracks[0].points.ele).toEqual([200, null]);
    expect(f.waypoints).toBe(1);
  });
});

describe("parseTcx: errors", () => {
  it("not-tcx, malformed, no-points", () => {
    expect(code(() => parseTcx(GPX_11_GARMIN))).toBe("not-tcx");
    expect(code(() => parseTcx(ACTIVITY.slice(0, 400)))).toBe("malformed");
    expect(code(() => parseTcx("<TrainingCenterDatabase><Activities><Activity><Lap><Track><Trackpoint><Time>2026-01-01T00:00:00Z</Time></Trackpoint></Track></Lap></Activity></Activities></TrainingCenterDatabase>"))).toBe("no-points");
  });
});

describe("parseTrackFile", () => {
  it("GPX or TCX by the root element, whatever the name; anything else is not-gpx", () => {
    expect(parseTrackFile(GPX_11_GARMIN).tracks[0].name).toBe("Morning ski");
    expect(parseTrackFile(ACTIVITY).tracks[0].points.lat.length).toBe(4);
    expect(code(() => parseTrackFile(KML))).toBe("not-gpx");
    expect(code(() => parseTrackFile("<gpx"))).toBe("malformed");
  });
});
