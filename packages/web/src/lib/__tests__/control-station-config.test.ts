import { describe, it, expect } from "vitest";
import { ControlStatus } from "@oxygen/shared";
import { AUTOSEND_MODE } from "../si-protocol";
import {
  statusSupportsAutosend,
  resolveAutosendMode,
} from "../control-station-config";

describe("statusSupportsAutosend", () => {
  it("covers the station types that read cards into results", () => {
    expect(statusSupportsAutosend(ControlStatus.OK)).toBe(true);
    expect(statusSupportsAutosend(ControlStatus.Start)).toBe(true);
    expect(statusSupportsAutosend(ControlStatus.Finish)).toBe(true);
    expect(statusSupportsAutosend(ControlStatus.Check)).toBe(true);
    expect(statusSupportsAutosend(ControlStatus.NoTiming)).toBe(true);
  });

  it("excludes clear and readout stations", () => {
    expect(statusSupportsAutosend(ControlStatus.Clear)).toBe(false);
    expect(statusSupportsAutosend(ControlStatus.Readout)).toBe(false);
  });
});

describe("resolveAutosendMode", () => {
  it("maps each stored variant onto its wire value", () => {
    const base = { status: ControlStatus.OK, radioType: "internal_radio" as const };
    expect(resolveAutosendMode({ ...base, autosendMode: "last" }))
      .toBe(AUTOSEND_MODE.SEND_LAST);
    expect(resolveAutosendMode({ ...base, autosendMode: "unsent" }))
      .toBe(AUTOSEND_MODE.SEND_UNSENT);
    expect(resolveAutosendMode({ ...base, autosendMode: "all" }))
      .toBe(AUTOSEND_MODE.SEND_ALL);
  });

  it("defaults to SEND_LAST when nothing is stored", () => {
    expect(
      resolveAutosendMode({
        status: ControlStatus.OK,
        radioType: "public_radio",
        autosendMode: null,
      }),
    ).toBe(AUTOSEND_MODE.SEND_LAST);
  });

  it("turns autosend off for a control with no radio", () => {
    expect(
      resolveAutosendMode({
        status: ControlStatus.OK,
        radioType: "normal",
        autosendMode: "all",
      }),
    ).toBe(AUTOSEND_MODE.OFF);
    expect(
      resolveAutosendMode({
        status: ControlStatus.OK,
        radioType: undefined,
        autosendMode: "all",
      }),
    ).toBe(AUTOSEND_MODE.OFF);
  });

  // The whole point of the fix: a radio-equipped check must ask for autosend.
  it("keeps autosend for a radio check station", () => {
    expect(
      resolveAutosendMode({
        status: ControlStatus.Check,
        radioType: "internal_radio",
        autosendMode: "last",
      }),
    ).toBe(AUTOSEND_MODE.SEND_LAST);
  });

  it("turns autosend off for clear and readout even with radio configured", () => {
    expect(
      resolveAutosendMode({
        status: ControlStatus.Clear,
        radioType: "internal_radio",
        autosendMode: "all",
      }),
    ).toBe(AUTOSEND_MODE.OFF);
    expect(
      resolveAutosendMode({
        status: ControlStatus.Readout,
        radioType: "internal_radio",
        autosendMode: "all",
      }),
    ).toBe(AUTOSEND_MODE.OFF);
  });
});
