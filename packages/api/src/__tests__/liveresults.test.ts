/**
 * Unit tests for the pure pieces of the LiveResults pump.
 *
 * The MySQL push surface is exercised manually via `liveresults.pushNow`
 * in the UI; here we just lock down the status-code mapping that
 * determines what shows up on liveresultat.orientering.se.
 */

import { describe, it, expect } from "vitest";
import { RunnerStatus } from "@oxygen/shared";
import { mapStatus } from "../liveresults.js";

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
