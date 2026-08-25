import { describe, expect, it } from "vitest";
import {
  aggregateRunner,
  median,
  parseResultList,
  parseTimeToSeconds,
  predictSeconds,
  summarizeClasses,
  toRunnerRaces,
  type RaceResult,
} from "../eventor-pace.js";

/**
 * Eventor's `results/event` speaks the older 2.0.3 dialect: person ids in
 * `PersonId`, running time as a clock string, status as an attribute.
 */
const XML_203 = `<?xml version="1.0" encoding="UTF-8"?>
<ResultList>
  <Event><EventId>1000</EventId><Name>Round 1</Name></Event>
  <ClassResult>
    <EventClass><EventClassId>7</EventClassId><Name>H12</Name></EventClass>
    <PersonResult>
      <Person sex="M">
        <PersonId>101</PersonId>
        <PersonName><Given>Fast</Given><Family>Kid</Family></PersonName>
      </Person>
      <Organisation><OrganisationId>5</OrganisationId><Name>OK Alpha</Name></Organisation>
      <Result>
        <StartTime><Clock>09:00:00</Clock></StartTime>
        <FinishTime><Clock>09:20:00</Clock></FinishTime>
        <Time>20:00</Time>
        <ResultPosition>1</ResultPosition>
        <CompetitorStatus value="OK"/>
      </Result>
    </PersonResult>
    <PersonResult>
      <Person><PersonId>102</PersonId>
        <PersonName><Given>Mid</Given><Family>Kid</Family></PersonName>
      </Person>
      <Organisation><OrganisationId>5</OrganisationId><Name>OK Alpha</Name></Organisation>
      <Result>
        <Time>30:00</Time>
        <ResultPosition>2</ResultPosition>
        <CompetitorStatus value="OK"/>
      </Result>
    </PersonResult>
    <PersonResult>
      <Person><PersonId>103</PersonId>
        <PersonName><Given>Slow</Given><Family>Kid</Family></PersonName>
      </Person>
      <Result>
        <StartTime><Clock>09:10:00</Clock></StartTime>
        <FinishTime><Clock>10:00:00</Clock></FinishTime>
        <ResultPosition>3</ResultPosition>
        <CompetitorStatus value="OK"/>
      </Result>
    </PersonResult>
    <PersonResult>
      <Person><PersonId>104</PersonId>
        <PersonName><Given>Lost</Given><Family>Kid</Family></PersonName>
      </Person>
      <Result>
        <Time>45:00</Time>
        <CompetitorStatus value="MisPunch"/>
      </Result>
    </PersonResult>
  </ClassResult>
</ResultList>`;

/** The IOF 3.0 dialect from `results/event/iofxml`: seconds, and a Course. */
const XML_30 = `<?xml version="1.0" encoding="UTF-8"?>
<ResultList xmlns="http://www.orienteering.org/datastandard/3.0" iofVersion="3.0">
  <Event><Id>1001</Id><Name>Round 2</Name></Event>
  <ClassResult>
    <Class><Id>7</Id><Name>H12</Name></Class>
    <Course><Length>2000</Length><Climb>40</Climb></Course>
    <PersonResult>
      <Person><Id type="Eventor">101</Id>
        <Name><Family>Kid</Family><Given>Fast</Given></Name>
      </Person>
      <Organisation><Id>5</Id><Name>OK Alpha</Name></Organisation>
      <Result>
        <Time>600</Time>
        <Position>1</Position>
        <Status>OK</Status>
      </Result>
    </PersonResult>
    <PersonResult>
      <Person><Id type="Eventor">103</Id>
        <Name><Family>Kid</Family><Given>Slow</Given></Name>
      </Person>
      <Result>
        <Time>1200</Time>
        <Position>2</Position>
        <Status>OK</Status>
        <Course><Length>2400</Length></Course>
      </Result>
    </PersonResult>
  </ClassResult>
</ResultList>`;

function results(xml: string): RaceResult[] {
  return parseResultList(xml).results;
}

function byPerson(rows: RaceResult[], personId: number): RaceResult {
  const row = rows.find((r) => r.personId === personId);
  if (!row) throw new Error(`no result for person ${personId}`);
  return row;
}

describe("parseTimeToSeconds", () => {
  it("reads mm:ss and hh:mm:ss clock strings", () => {
    expect(parseTimeToSeconds("20:00")).toBe(1200);
    expect(parseTimeToSeconds("1:05:12")).toBe(3912);
  });

  it("reads bare seconds, including fractions", () => {
    expect(parseTimeToSeconds("600")).toBe(600);
    expect(parseTimeToSeconds("600.4")).toBe(600);
  });

  it("returns 0 for junk rather than NaN", () => {
    expect(parseTimeToSeconds("")).toBe(0);
    expect(parseTimeToSeconds("--")).toBe(0);
  });
});

describe("parseResultList — Eventor 2.0.3", () => {
  it("detects the dialect and reads every person result", () => {
    const parsed = parseResultList(XML_203);
    expect(parsed.iofVersion).toBe("2.0.3");
    expect(parsed.results).toHaveLength(4);
  });

  it("reads person, class and time", () => {
    const row = byPerson(results(XML_203), 101);
    expect(row.className).toBe("H12");
    expect(row.classKey).toBe("7");
    expect(row.timeSec).toBe(1200);
    expect(row.status).toBe("OK");
    expect(row.name).toBe("Kid, Fast");
    expect(row.clubName).toBe("OK Alpha");
  });

  it("falls back to finish minus start when Time is absent", () => {
    expect(byPerson(results(XML_203), 103).timeSec).toBe(3000);
  });

  it("maps Eventor status values and keeps non-finishers in the list", () => {
    expect(byPerson(results(XML_203), 104).status).toBe("MissingPunch");
  });

  it("reports no course length, since the dialect carries none", () => {
    expect(results(XML_203).every((r) => r.courseLengthM === 0)).toBe(true);
  });
});

describe("parseResultList — IOF 3.0", () => {
  it("detects the dialect and reads seconds directly", () => {
    const parsed = parseResultList(XML_30);
    expect(parsed.iofVersion).toBe("3.0");
    expect(byPerson(parsed.results, 101).timeSec).toBe(600);
  });

  it("unwraps a typed Person/Id", () => {
    expect(byPerson(results(XML_30), 101).personId).toBe(101);
  });

  it("takes the class course length", () => {
    expect(byPerson(results(XML_30), 101).courseLengthM).toBe(2000);
  });

  it("prefers a per-person course over the class one, for forked classes", () => {
    expect(byPerson(results(XML_30), 103).courseLengthM).toBe(2400);
  });
});

describe("summarizeClasses", () => {
  it("medians only the finishers", () => {
    const summary = summarizeClasses(results(XML_203)).get("7");
    // 1200, 1800, 3000 — the mispunch is excluded.
    expect(summary?.finishers).toBe(3);
    expect(summary?.medianSec).toBe(1800);
    expect(summary?.bestSec).toBe(1200);
  });

  it("carries the course length through when the dialect has one", () => {
    expect(summarizeClasses(results(XML_30)).get("7")?.courseLengthM).toBe(2000);
  });

  it("handles a class with a single finisher", () => {
    const single: RaceResult[] = [
      {
        personId: 1,
        name: "Solo, Han",
        clubName: "",
        classKey: "9",
        className: "D16",
        timeSec: 900,
        status: "OK",
        courseLengthM: 0,
      },
    ];
    const summary = summarizeClasses(single).get("9");
    expect(summary?.medianSec).toBe(900);
    expect(summary?.finishers).toBe(1);
  });

  it("skips classes where nobody finished", () => {
    const allMp: RaceResult[] = [
      {
        personId: 1,
        name: "A",
        clubName: "",
        classKey: "9",
        className: "D16",
        timeSec: 900,
        status: "MissingPunch",
        courseLengthM: 0,
      },
    ];
    expect(summarizeClasses(allMp).size).toBe(0);
  });
});

describe("toRunnerRaces", () => {
  it("scores a finisher against the class median", () => {
    const rows = results(XML_203);
    const races = toRunnerRaces(rows, summarizeClasses(rows));
    const fast = races.find((r) => r.personId === 101);
    const slow = races.find((r) => r.personId === 103);
    expect(fast?.ratio).toBeCloseTo(1200 / 1800, 5);
    expect(slow?.ratio).toBeCloseTo(3000 / 1800, 5);
  });

  it("leaves pace null when the race has no course length", () => {
    const rows = results(XML_203);
    const races = toRunnerRaces(rows, summarizeClasses(rows));
    expect(races.find((r) => r.personId === 101)?.paceMinPerKm).toBeNull();
  });

  it("computes min/km from the runner's own course length", () => {
    const rows = results(XML_30);
    const races = toRunnerRaces(rows, summarizeClasses(rows));
    // 600 s over 2000 m = 5 min/km.
    expect(races.find((r) => r.personId === 101)?.paceMinPerKm).toBeCloseTo(5, 5);
    // 1200 s over the forked 2400 m course = 8.33 min/km.
    expect(races.find((r) => r.personId === 103)?.paceMinPerKm).toBeCloseTo(
      1200 / 60 / 2.4,
      5,
    );
  });

  it("keeps non-finishers with a null ratio so they can be counted", () => {
    const rows = results(XML_203);
    const races = toRunnerRaces(rows, summarizeClasses(rows));
    const mp = races.find((r) => r.personId === 104);
    expect(mp?.ratio).toBeNull();
    expect(mp?.status).toBe("MissingPunch");
  });
});

describe("aggregateRunner", () => {
  const race = (ratio: number | null, pace: number | null = null) => ({
    personId: 101,
    className: "H12",
    timeSec: 1000,
    ratio,
    paceMinPerKm: pace,
    status: ratio === null ? ("MissingPunch" as const) : ("OK" as const),
  });

  it("takes the median ratio so one disaster does not dominate", () => {
    const agg = aggregateRunner([race(0.9), race(1.0), race(2.5)]);
    expect(agg.ratio).toBe(1.0);
    expect(agg.races).toBe(3);
  });

  it("counts non-finishes separately from the timed races", () => {
    const agg = aggregateRunner([race(0.9), race(null), race(1.1)]);
    expect(agg.races).toBe(2);
    expect(agg.dnf).toBe(1);
    expect(agg.ratio).toBeCloseTo(1.0, 5);
  });

  it("returns nulls for a runner with no usable history", () => {
    const agg = aggregateRunner([race(null)]);
    expect(agg.ratio).toBeNull();
    expect(agg.paceMinPerKm).toBeNull();
    expect(agg.races).toBe(0);
    expect(agg.dnf).toBe(1);
  });

  it("medians pace only over the races that had a length", () => {
    const agg = aggregateRunner([race(1.0, 6), race(1.0, null), race(1.0, 8)]);
    expect(agg.paceMinPerKm).toBe(7);
  });

  it("aggregates across a class change, since ratios are class-relative", () => {
    const agg = aggregateRunner([
      { ...race(1.2), className: "H12" },
      { ...race(1.4), className: "H14" },
    ]);
    expect(agg.races).toBe(2);
    expect(agg.ratio).toBeCloseTo(1.3, 5);
  });
});

describe("median", () => {
  it("averages the middle pair for an even count", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("is order-independent", () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it("returns 0 for an empty set", () => {
    expect(median([])).toBe(0);
  });
});

describe("predictSeconds", () => {
  it("scales the class target pace by the runner's ratio", () => {
    // 1.5 km at 6 min/km = 540 s for an average runner; 20 percent slower = 648 s.
    expect(predictSeconds(1.2, 1500, 6)).toBe(648);
  });

  it("returns 0 when the target pace is unknown", () => {
    expect(predictSeconds(1.2, 1500, 0)).toBe(0);
  });
});
