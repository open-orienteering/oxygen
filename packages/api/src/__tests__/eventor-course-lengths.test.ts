import { describe, expect, it } from "vitest";
import { parseEventorStartListCourseLengths } from "../eventor.js";

const START_LIST = `<?xml version="1.0" encoding="utf-8"?>
<StartList xmlns="http://www.orienteering.org/datastandard/3.0"
           iofVersion="3.0" creator="Eventor">
  <ClassStart>
    <Class>
      <Id type="Sweden">682901</Id>
      <Name>D16</Name>
    </Class>
    <Course raceNumber="1"><Length>2530</Length></Course>
  </ClassStart>
  <ClassStart>
    <Class>
      <Id type="Sweden">682913</Id>
      <Name>U4</Name>
    </Class>
    <Course raceNumber="1"><Length>2480</Length></Course>
    <PersonStart>
      <Person><Name><Family>Winby</Family><Given>Elsa</Given></Name></Person>
      <Start raceNumber="1"><Course><Length>2480</Length></Course></Start>
    </PersonStart>
  </ClassStart>
  <ClassStart>
    <Class><Id type="Sweden">999</Id><Name>Length missing</Name></Class>
    <Course raceNumber="1" />
  </ClassStart>
</StartList>`;

describe("parseEventorStartListCourseLengths", () => {
  it("reads the authoritative class course lengths from Eventor IOF 3.0", () => {
    expect(parseEventorStartListCourseLengths(START_LIST)).toEqual([
      { classId: 682901, className: "D16", courseLengthM: 2530 },
      { classId: 682913, className: "U4", courseLengthM: 2480 },
    ]);
  });

  it("returns an empty list for a malformed or unrelated document", () => {
    expect(parseEventorStartListCourseLengths("<foo />")).toEqual([]);
  });
});
