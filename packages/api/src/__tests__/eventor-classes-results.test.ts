/**
 * fetchEventClasses / fetchResults against stubbed Eventor responses
 * (review EVT-03, EVT-04).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchEventClasses, fetchResults } from "../eventor.js";

const EVENT_CLASSES = `<EventClassList>
  <EventClass sex="M" lowAge="0" highAge="0" sequence="1">
    <EventClassId>10</EventClassId><Name>H21</Name><ClassShortName>H21</ClassShortName>
    <ClassType><Name>Open</Name></ClassType>
  </EventClass>
  <EventClass sex="F" lowAge="0" highAge="12" sequence="2">
    <EventClassId>11</EventClassId><Name>Inskolning</Name><ClassShortName>Insk</ClassShortName>
    <ClassType><Name>Open</Name></ClassType>
  </EventClass>
</EventClassList>`;

const EXPORT_CLASSES = `<ClassList>
  <Class resultListMode="Default"><Name>H21</Name></Class>
  <Class resultListMode="UnorderedNoTimes"><Name>Inskolning</Name></Class>
</ClassList>`;

function stubFetch(handlers: Record<string, () => Response | Promise<Response>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
      for (const [key, fn] of Object.entries(handlers)) {
        if (url.includes(key)) return fn();
      }
      throw new Error(`unexpected request ${path}`);
    }),
  );
}
const ok = (xml: string) => () => new Response(xml, { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchEventClasses no-timing enrichment (EVT-03)", () => {
  it("reads the no-timing classes when export/classes answers", async () => {
    stubFetch({
      eventclasses: ok(EVENT_CLASSES),
      "export/classes": ok(EXPORT_CLASSES),
      "starts/event/iofxml": ok("<StartList />"),
    });
    const classes = await fetchEventClasses("k", 1);
    expect(classes.map((c) => c.noTiming)).toEqual([false, true]);
  });

  it("leaves noTiming undefined (no opinion) when export/classes fails, and logs it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch({
      eventclasses: ok(EVENT_CLASSES),
      "export/classes": () => new Response("", { status: 500, statusText: "Boom" }),
      "starts/event/iofxml": ok("<StartList />"),
    });
    const classes = await fetchEventClasses("k", 1);
    expect(classes.map((c) => c.noTiming)).toEqual([undefined, undefined]);
    expect(warn).toHaveBeenCalled();
  });

  it("treats a 200 without a ClassList as unknown, not as 'no class is no-timing'", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch({
      eventclasses: ok(EVENT_CLASSES),
      "export/classes": ok("<Other />"),
      "starts/event/iofxml": ok("<StartList />"),
    });
    const classes = await fetchEventClasses("k", 1);
    expect(classes.every((c) => c.noTiming === undefined)).toBe(true);
  });
});

describe("fetchResults (EVT-04)", () => {
  it("returns bib and times but no start number from the result position", async () => {
    stubFetch({
      "results/event": ok(`<ResultList><ClassResult><EventClass><EventClassId>10</EventClassId></EventClass>
        <PersonResult><Person><PersonId>5</PersonId><PersonName><Given>A</Given><Family>B</Family></PersonName></Person>
        <Result><ResultPosition>3</ResultPosition><BibNumber>H4</BibNumber>
        <StartTime><Clock>10:00:00</Clock></StartTime><FinishTime><Clock>10:30:00</Clock></FinishTime>
        <CompetitorStatus value="OK"/></Result></PersonResult></ClassResult></ResultList>`),
    });
    const [r] = await fetchResults("k", 1);
    expect(r).not.toHaveProperty("startNo");
    expect(r).toMatchObject({ bib: "H4", startTime: 360000, finishTime: 378000, status: 1 });
  });
});
