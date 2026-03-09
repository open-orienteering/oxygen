/**
 * Unit tests for kiosk screen routing logic.
 */

import { describe, it, expect } from "vitest";
import { determineKioskScreen, type CardInfo, type DbRunnerInfo } from "../kiosk-routing";
import { RunnerStatus } from "@oxygen/shared";

describe("determineKioskScreen", () => {
  // ── No runner in DB (unknown card) ────────────────────────

  it("returns registration-waiting for unknown card (action=register)", () => {
    const card: CardInfo = { action: "register", hasRaceData: false, cardNumber: 12345 };
    expect(determineKioskScreen(card, null)).toBe("registration-waiting");
  });

  it("returns registration-waiting for unknown card even with other actions", () => {
    const card: CardInfo = { action: "pre-start", hasRaceData: false, cardNumber: 12345 };
    expect(determineKioskScreen(card, null)).toBe("registration-waiting");
  });

  // ── Known runner, no finish, no race data → pre-start ─────

  it("returns pre-start for known runner with no finish and no race data", () => {
    const card: CardInfo = { action: "pre-start", hasRaceData: false, cardNumber: 12345 };
    const dbRunner: DbRunnerInfo = { finishTime: 0, status: RunnerStatus.Unknown };
    expect(determineKioskScreen(card, dbRunner)).toBe("pre-start");
  });

  it("returns pre-start even if card action says register but runner exists", () => {
    // Race condition: DeviceManager says register but DB has the runner
    const card: CardInfo = { action: "register", hasRaceData: false, cardNumber: 12345 };
    const dbRunner: DbRunnerInfo = { finishTime: 0, status: RunnerStatus.Unknown };
    expect(determineKioskScreen(card, dbRunner)).toBe("pre-start");
  });

  // ── Known runner with race data but no finish → readout ───

  it("returns readout for known runner with race data but finishTime=0", () => {
    const card: CardInfo = { action: "readout", hasRaceData: true, cardNumber: 12345 };
    const dbRunner: DbRunnerInfo = { finishTime: 0, status: RunnerStatus.Unknown };
    expect(determineKioskScreen(card, dbRunner)).toBe("readout");
  });

  // ── Known runner with finish time → readout (reprint) ─────

  it("returns readout for known runner with finishTime > 0 (reprint)", () => {
    const card: CardInfo = { action: "readout", hasRaceData: true, cardNumber: 12345 };
    const dbRunner: DbRunnerInfo = { finishTime: 360000, status: RunnerStatus.OK };
    expect(determineKioskScreen(card, dbRunner)).toBe("readout");
  });

  it("returns readout for finished runner even if card has no race data", () => {
    // Edge case: card was cleared after result was recorded
    const card: CardInfo = { action: "pre-start", hasRaceData: false, cardNumber: 12345 };
    const dbRunner: DbRunnerInfo = { finishTime: 360000, status: RunnerStatus.OK };
    expect(determineKioskScreen(card, dbRunner)).toBe("readout");
  });

  it("returns readout for MP runner with finish time", () => {
    const card: CardInfo = { action: "readout", hasRaceData: true, cardNumber: 12345 };
    const dbRunner: DbRunnerInfo = { finishTime: 367200, status: RunnerStatus.MissingPunch };
    expect(determineKioskScreen(card, dbRunner)).toBe("readout");
  });

  it("returns readout for DNF runner with finish time", () => {
    const card: CardInfo = { action: "readout", hasRaceData: true, cardNumber: 12345 };
    const dbRunner: DbRunnerInfo = { finishTime: 370000, status: RunnerStatus.DNF };
    expect(determineKioskScreen(card, dbRunner)).toBe("readout");
  });
});
