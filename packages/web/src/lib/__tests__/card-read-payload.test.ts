import { describe, it, expect } from "vitest";
import { toOfflineCardReadPayload } from "../offline/card-read-payload";
import type { SICardReadout } from "../si-protocol";

function readout(p: Partial<SICardReadout> = {}): SICardReadout {
  return {
    cardNumber: 415887,
    cardType: "SIAC",
    checkTime: null,
    startTime: null,
    finishTime: null,
    clearTime: null,
    punches: [],
    punchCount: 0,
    ...p,
  } as SICardReadout;
}

describe("toOfflineCardReadPayload", () => {
  it("converts punch and header times from seconds to absolute deciseconds", () => {
    // Regression: the offline emit used to send raw seconds while the online
    // storeReadout path multiplied by 10 — a 10x drift once the queue drained.
    const payload = toOfflineCardReadPayload(
      readout({
        punches: [
          { controlCode: 31, time: 36000 },
          { controlCode: 32, time: 36123 },
        ] as SICardReadout["punches"],
        checkTime: 35900,
        startTime: 36000,
        finishTime: 37000,
      }),
      true,
    );
    expect(payload.punches).toEqual([
      { controlCode: 31, time: 360000 },
      { controlCode: 32, time: 361230 },
    ]);
    expect(payload.checkTime).toBe(359000);
    expect(payload.startTime).toBe(360000);
    expect(payload.finishTime).toBe(370000);
  });

  it("maps null/undefined header times to undefined (not 0)", () => {
    const payload = toOfflineCardReadPayload(readout(), false);
    expect(payload.checkTime).toBeUndefined();
    expect(payload.startTime).toBeUndefined();
    expect(payload.finishTime).toBeUndefined();
  });

  it("carries card identity, freshness and battery voltage through", () => {
    const payload = toOfflineCardReadPayload(
      readout({ batteryVoltage: 2.91 }),
      true,
    );
    expect(payload.cardNo).toBe(415887);
    expect(payload.cardType).toBe("SIAC");
    expect(payload.punchesFresh).toBe(true);
    expect(payload.batteryVoltage).toBe(2.91);
  });

  it("passes owner data through when present", () => {
    const payload = toOfflineCardReadPayload(
      readout({ ownerData: { firstName: "Anna", lastName: "K", club: "OK Test" } }),
      true,
    );
    expect(payload.ownerData).toMatchObject({ firstName: "Anna", club: "OK Test" });
  });
});
