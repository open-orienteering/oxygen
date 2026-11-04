import { describe, it, expect, vi, afterEach } from "vitest";
import { RBT_MSG, decodeCardData, toSICardReadout, type RbtCardData } from "../reader-bt";
import { isPunchDataFresh } from "../../context/DeviceManager";
import { SIAC_CARD, SI8_CARD, cardPayload, message, weekMs, type CardSpec } from "./fixtures/reader-bt";

const decode = (spec: CardSpec, id: number = RBT_MSG.CARD_DATA_COMPLETE): RbtCardData =>
  decodeCardData(message(id, cardPayload(spec)));

const card = (punches: CardSpec["punches"], extra: Partial<CardSpec> = {}): RbtCardData =>
  decode({ cardNumber: 2220164, family: 2, punches, ...extra });

describe("toSICardReadout — times and day of week", () => {
  it("routes an SI8 readout into the SICardReadout shape with integer seconds", () => {
    const r = toSICardReadout(decode(SI8_CARD));
    expect(r.cardNumber).toBe(2220164);
    expect(r.cardType).toBe("SI8");
    expect(r.clearTime).toBe(9 * 3600);
    expect(r.checkTime).toBe(9 * 3600 + 58 * 60);
    expect(r.startTime).toBe(10 * 3600);
    expect(r.finishTime).toBe(10 * 3600 + 30 * 60 + 45);
    expect(r.punches).toEqual([
      { controlCode: 31, time: 10 * 3600 + 5 * 60 + 10 },
      { controlCode: 32, time: 10 * 3600 + 10 * 60 + 20 },
    ]);
    expect(r.punchCount).toBe(2);
    expect(r.finishDayOfWeek).toBe(1); // Monday
    expect(r.checkDayOfWeek).toBe(1);
    expect(r.ownerData).toEqual({ firstName: "Anna", lastName: "Svensson" });
    expect(r.batteryVoltage).toBeNull();
    expect(r.metadata).toBeNull();
  });

  it("maps Sunday (day index 0) to SI day 7", () => {
    const r = toSICardReadout(card([{ type: 5, code: 0, timeMs: weekMs(0, 11, 0, 0) }]));
    expect(r.finishDayOfWeek).toBe(7);
    expect(r.finishTime).toBe(11 * 3600);
  });

  it("maps Saturday (day index 6) to SI day 6", () => {
    const r = toSICardReadout(card([{ type: 2, code: 0, timeMs: weekMs(6, 23, 59, 59) }]));
    expect(r.checkDayOfWeek).toBe(6);
    expect(r.checkTime).toBe(86399);
    expect(r.finishDayOfWeek).toBeNull();
  });

  it("keeps the time of day across midnight and reports the finish day", () => {
    const r = toSICardReadout(
      card([
        { type: 3, code: 0, timeMs: weekMs(6, 23, 50, 0) },
        { type: 7, code: 40, timeMs: weekMs(6, 23, 58, 30) },
        { type: 7, code: 41, timeMs: weekMs(0, 0, 4, 15) },
        { type: 5, code: 0, timeMs: weekMs(0, 0, 10, 0) },
      ]),
    );
    expect(r.startTime).toBe(23 * 3600 + 50 * 60);
    expect(r.punches.map((p) => p.time)).toEqual([23 * 3600 + 58 * 60 + 30, 4 * 60 + 15]);
    expect(r.finishTime).toBe(10 * 60);
    expect(r.finishDayOfWeek).toBe(7);
  });

  it("drops the millisecond part (floor, never round)", () => {
    const r = toSICardReadout(card([{ type: 7, code: 31, timeMs: weekMs(2, 3, 4, 5, 999) }]));
    expect(r.punches[0].time).toBe(3 * 3600 + 4 * 60 + 5);
    // The docs' worked example: 183845000 = Tuesday 03:04:05.000
    expect(weekMs(2, 3, 4, 5)).toBe(183_845_000);
  });
});

describe("toSICardReadout — punch type routing", () => {
  it("uses start-reserve and finish-reserve only when the primary is missing", () => {
    const reserveOnly = toSICardReadout(
      card([
        { type: 4, code: 0, timeMs: weekMs(3, 10, 0, 0) },
        { type: 6, code: 0, timeMs: weekMs(3, 11, 0, 0) },
      ]),
    );
    expect(reserveOnly.startTime).toBe(10 * 3600);
    expect(reserveOnly.finishTime).toBe(11 * 3600);
    expect(reserveOnly.finishDayOfWeek).toBe(3);

    const both = toSICardReadout(
      card([
        { type: 4, code: 0, timeMs: weekMs(3, 9, 0, 0) },
        { type: 3, code: 0, timeMs: weekMs(3, 10, 0, 0) },
        { type: 5, code: 0, timeMs: weekMs(3, 11, 0, 0) },
        { type: 6, code: 0, timeMs: weekMs(4, 1, 0, 0) },
      ]),
    );
    expect(both.startTime).toBe(10 * 3600);
    expect(both.finishTime).toBe(11 * 3600);
    expect(both.finishDayOfWeek).toBe(3);
  });

  it("treats undefined (0) and control (7) as course punches, in card order", () => {
    const r = toSICardReadout(
      card([
        { type: 7, code: 31, timeMs: weekMs(1, 10, 0, 0) },
        { type: 0, code: 99, timeMs: weekMs(1, 10, 1, 0) },
        { type: 7, code: 33, timeMs: weekMs(1, 10, 2, 0) },
      ]),
    );
    expect(r.punches.map((p) => p.controlCode)).toEqual([31, 99, 33]);
    expect(r.punchCount).toBe(3);
  });

  it("returns nulls for a card with no punches", () => {
    const r = toSICardReadout(card([]));
    expect(r.clearTime).toBeNull();
    expect(r.checkTime).toBeNull();
    expect(r.startTime).toBeNull();
    expect(r.finishTime).toBeNull();
    expect(r.finishDayOfWeek).toBeNull();
    expect(r.checkDayOfWeek).toBeNull();
    expect(r.punches).toEqual([]);
    expect(r.punchCount).toBe(0);
  });
});

describe("toSICardReadout — card type, battery, owner", () => {
  it("maps the documented families", () => {
    expect(toSICardReadout(card([], { cardNumber: 1234567, family: 1 })).cardType).toBe("SI9");
    expect(toSICardReadout(card([], { cardNumber: 2234567, family: 2 })).cardType).toBe("SI8");
    expect(toSICardReadout(card([], { cardNumber: 4234567, family: 4 })).cardType).toBe("pCard");
    // Minimal readout: a complete SIAC 8xxxxxx readout would carry the production block
    const siac = decode({ cardNumber: 8234567, family: 15, punches: [] }, RBT_MSG.CARD_DATA_MINIMAL);
    expect(toSICardReadout(siac).cardType).toBe("SIAC");
  });

  it("falls back to the number range for an unknown family (7xxxxxx → SI10)", () => {
    expect(toSICardReadout(card([], { cardNumber: 7123456, family: 9 })).cardType).toBe("SI10");
  });

  it("lets the number range win when it disagrees with the family", () => {
    // SI10 numbers might arrive under the SI9 family code
    expect(toSICardReadout(card([], { cardNumber: 7123456, family: 1 })).cardType).toBe("SI10");
  });

  it("keeps the family when the number range is unknown", () => {
    expect(toSICardReadout(card([], { cardNumber: 3000000, family: 15 })).cardType).toBe("SIAC");
    expect(toSICardReadout(card([], { cardNumber: 3000000, family: 9 })).cardType).toBe("Unknown");
  });

  it("converts the SIAC battery from millivolts to volts and fills metadata", () => {
    const r = toSICardReadout(decode(SIAC_CARD));
    expect(r.cardType).toBe("SIAC");
    expect(r.batteryVoltage).toBeCloseTo(3.05, 5);
    expect(r.metadata).toEqual({
      hardwareVersion: "3.1",
      softwareVersion: "6.4",
      clearCount: 45,
      batteryDate: "2024-03-15",
      productionDate: "2023-11",
    });
  });

  it("assigns owner fields in PERSONAL_FIELDS order", () => {
    const r = toSICardReadout(decode(SIAC_CARD));
    expect(Object.keys(r.ownerData!)).toEqual([
      "firstName",
      "lastName",
      "sex",
      "dateOfBirth",
      "club",
      "email",
      "phone",
      "city",
      "street",
      "postcode",
      "country",
    ]);
    expect(r.ownerData!.city).toBe("Västerås");
  });

  it("has no owner data for a minimal readout", () => {
    const r = toSICardReadout(decode(SI8_CARD, RBT_MSG.CARD_DATA_MINIMAL));
    expect(r.ownerData).toBeNull();
  });
});

describe("toSICardReadout → isPunchDataFresh", () => {
  afterEach(() => vi.useRealTimers());

  // Wednesday 2026-11-04 12:00 local time
  const WEDNESDAY = new Date(2026, 10, 4, 12, 0, 0);

  it("accepts a readout finished today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(WEDNESDAY);
    const today = WEDNESDAY.getDay(); // 3 = Wednesday, as ms-since-Sunday day index
    const r = toSICardReadout(
      card([
        { type: 3, code: 0, timeMs: weekMs(today, 10, 0, 0) },
        { type: 7, code: 31, timeMs: weekMs(today, 10, 10, 0) },
        { type: 5, code: 0, timeMs: weekMs(today, 10, 30, 0) },
      ]),
    );
    expect(r.finishDayOfWeek).toBe(3);
    expect(isPunchDataFresh(r)).toBe(true);
  });

  it("rejects a readout finished three days ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(WEDNESDAY);
    const r = toSICardReadout(
      card([
        { type: 7, code: 31, timeMs: weekMs(0, 10, 10, 0) },
        { type: 5, code: 0, timeMs: weekMs(0, 10, 30, 0) },
      ]),
    );
    expect(r.finishDayOfWeek).toBe(7);
    expect(isPunchDataFresh(r)).toBe(false);
  });

  it("accepts a Sunday finish on Monday (night-O over midnight)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 2, 0, 30, 0)); // Monday
    const r = toSICardReadout(
      card([
        { type: 7, code: 31, timeMs: weekMs(0, 23, 40, 0) },
        { type: 5, code: 0, timeMs: weekMs(0, 23, 55, 0) },
      ]),
    );
    expect(isPunchDataFresh(r)).toBe(true);
  });
});
