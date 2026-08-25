/**
 * Unit tests for the pure pieces of the LiveResults pump.
 *
 * The MySQL push surface is exercised manually via `liveresults.pushNow`
 * in the UI; here we lock down the status-code mapping, the
 * visit×1000+code radio encoding that other clients (MeOS, the official
 * LiveResults uploader) write, credential hashing, and the
 * splitcontrols class-name scope so a sync cannot wipe another system's
 * radio definitions.
 */

import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { RunnerStatus } from "@oxygen/shared";
import {
  encodedRadioPunches,
  hashLiveResultsCredential,
  liveResultsRadioCode,
  mapStatus,
  radioControlsFromCourse,
  splitcontrolClassnamesToReplace,
} from "../liveresults.js";

describe("liveresults.mapStatus", () => {
  it("maps OK / NoTiming to 0 (finished)", () => {
    expect(mapStatus(RunnerStatus.OK, 360000)).toBe(0);
    expect(mapStatus(RunnerStatus.NoTiming, 360000)).toBe(0);
  });

  it("maps MissingPunch to 3", () => {
    expect(mapStatus(RunnerStatus.MissingPunch, 360000)).toBe(3);
  });

  it("maps DNF to 2", () => {
    expect(mapStatus(RunnerStatus.DNF, 0)).toBe(2);
  });

  it("maps DQ to 4 (DSQ)", () => {
    expect(mapStatus(RunnerStatus.DQ, 360000)).toBe(4);
  });

  it("maps OverMaxTime / OutOfCompetition to 5 (OT)", () => {
    expect(mapStatus(RunnerStatus.OverMaxTime, 360000)).toBe(5);
    expect(mapStatus(RunnerStatus.OutOfCompetition, 360000)).toBe(5);
  });

  it("maps DNS / Cancel to 1 (DNS)", () => {
    expect(mapStatus(RunnerStatus.DNS, 0)).toBe(1);
    expect(mapStatus(RunnerStatus.Cancel, 0)).toBe(1);
  });

  it("maps NotCompeting to 9 (not started)", () => {
    expect(mapStatus(RunnerStatus.NotCompeting, 0)).toBe(9);
  });

  it("falls back to 0 when status is Unknown but the runner finished", () => {
    expect(mapStatus(RunnerStatus.Unknown, 360000)).toBe(0);
  });

  it("falls back to 9 when status is Unknown and no finish time exists", () => {
    expect(mapStatus(RunnerStatus.Unknown, 0)).toBe(9);
  });
});

describe("liveresults.liveResultsRadioCode", () => {
  it("encodes the first visit as 1000 + punch code (82 → 1082)", () => {
    expect(liveResultsRadioCode(82, 1)).toBe(1082);
    expect(liveResultsRadioCode(96, 1)).toBe(1096);
  });

  it("encodes later visits as visit × 1000 + punch code", () => {
    expect(liveResultsRadioCode(100, 2)).toBe(2100);
    expect(liveResultsRadioCode(100, 12)).toBe(12100);
  });

  it("rejects a non-positive visit index", () => {
    expect(() => liveResultsRadioCode(82, 0)).toThrow(/visit/i);
  });
});

describe("liveresults.radioControlsFromCourse", () => {
  it("numbers radio visits against the whole course, not just other radios", () => {
    const radios = radioControlsFromCourse([
      { codes: "31", radioType: "normal", name: "Start" },
      { codes: "96", radioType: "radio", name: "96" },
      { codes: "82", radioType: "normal", name: "82" },
      { codes: "82", radioType: "radio", name: "82" },
    ]);
    expect(radios).toEqual([
      { punchCode: 96, encoded: 1096, name: "96" },
      { punchCode: 82, encoded: 2082, name: "82" },
    ]);
  });

  it("uses the first punch code of a multi-code control", () => {
    const radios = radioControlsFromCourse([
      { codes: "55;155", radioType: "radio", name: "" },
    ]);
    expect(radios).toEqual([{ punchCode: 55, encoded: 1055, name: "55" }]);
  });

  it("skips controls without a parseable code", () => {
    expect(
      radioControlsFromCourse([{ codes: "", radioType: "radio", name: "x" }]),
    ).toEqual([]);
  });
});

describe("liveresults.encodedRadioPunches", () => {
  it("emits the first punch of a once-on-course radio as 1xxx", () => {
    expect(
      encodedRadioPunches(
        [
          { controlCode: 82, time: 100 },
          { controlCode: 82, time: 110 },
        ],
        [1082],
      ),
    ).toEqual([{ encoded: 1082, time: 100 }]);
  });

  it("keeps a second visit when the course actually has that radio twice", () => {
    expect(
      encodedRadioPunches(
        [
          { controlCode: 82, time: 100 },
          { controlCode: 82, time: 250 },
        ],
        [1082, 2082],
      ),
    ).toEqual([
      { encoded: 1082, time: 100 },
      { encoded: 2082, time: 250 },
    ]);
  });

  it("drops a punch whose visit number is not one of the class radios", () => {
    expect(
      encodedRadioPunches([{ controlCode: 82, time: 100 }], [2082]),
    ).toEqual([]);
  });
});

describe("liveresults.hashLiveResultsCredential", () => {
  it("stores the same 32-char md5 the official LiveResults clients write", () => {
    const hashed = hashLiveResultsCredential("oxygen_9876545");
    expect(hashed).toHaveLength(32);
    expect(hashed).toBe(
      createHash("md5").update("oxygen_9876545", "utf8").digest("hex"),
    );
  });
});

describe("liveresults.splitcontrolClassnamesToReplace", () => {
  it("scopes the wipe to Oxygen class names, truncated to the login column width", () => {
    expect(
      splitcontrolClassnamesToReplace([
        { name: "U4" },
        { name: "H12" },
        { name: "U4" },
        { name: "X".repeat(60) },
      ]),
    ).toEqual(["U4", "H12", "X".repeat(50)]);
  });
});
