import { describe, expect, it } from "vitest";
import { decideReadoutApply, type ReadoutGuardCurrent } from "../readout-guard.js";
import { RunnerStatus as S } from "../types.js";

const base: ReadoutGuardCurrent = {
  status: S.Unknown,
  finishTime: 0,
  startTime: 0,
  statusManual: false,
  finishManual: false,
};
const ok = { status: S.OK, finishTime: 5000, startTime: 1000 };

describe("decideReadoutApply", () => {
  it("applies a first read", () => {
    const d = decideReadoutApply(base, ok);
    expect(d.outcome).toBe("apply");
    expect(d.write).toEqual(ok);
  });

  it("never overwrites a DQ, even when confirmed", () => {
    const cur = { ...base, status: S.DQ, finishTime: 5000, startTime: 1000 };
    for (const confirmed of [false, true]) {
      const d = decideReadoutApply(cur, ok, confirmed);
      expect(d.outcome).toBe("protected");
      expect(d.reason).toBe("dq");
      expect(d.write.status).toBe(S.DQ);
    }
  });

  it("protects a hand-set result status", () => {
    const cur = { ...base, status: S.OK, statusManual: true, finishTime: 5000, startTime: 1000 };
    const d = decideReadoutApply(cur, { ...ok, status: S.MissingPunch });
    expect(d.outcome).toBe("protected");
    expect(d.reason).toBe("manual-status");
  });

  it("asks before replacing a hand-set DNS, and applies once confirmed", () => {
    const cur = { ...base, status: S.DNS, statusManual: true };
    expect(decideReadoutApply(cur, ok).outcome).toBe("needsConfirmation");
    expect(decideReadoutApply(cur, ok, true).outcome).toBe("apply");
  });

  it("keeps a hand-keyed finish when the card has no finish punch", () => {
    const cur = { ...base, finishTime: 4000, finishManual: true, startTime: 1000 };
    const d = decideReadoutApply(cur, { status: S.DNF, finishTime: 0, startTime: 1000 });
    expect(d.write.finishTime).toBe(4000);
  });

  it("asks before a cleared card replaces an OK result with DNF", () => {
    const cur = { ...base, status: S.OK, finishTime: 5000, startTime: 1000 };
    const next = { status: S.DNF, finishTime: 0, startTime: 0 };
    const d = decideReadoutApply(cur, next);
    expect(d.outcome).toBe("needsConfirmation");
    expect(d.reason).toBe("no-finish");
    expect(decideReadoutApply(cur, next, true).outcome).toBe("apply");
  });

  it("asks on a read the reader marks as not fresh", () => {
    const cur = { ...base, status: S.OK, finishTime: 5000, startTime: 1000 };
    const d = decideReadoutApply(cur, { ...ok, status: S.MissingPunch, punchesFresh: false });
    expect(d.outcome).toBe("needsConfirmation");
    expect(d.reason).toBe("stale-punches");
  });

  it("treats identical values as unchanged", () => {
    const cur = { ...base, status: S.OK, finishTime: 5000, startTime: 1000 };
    expect(decideReadoutApply(cur, ok).outcome).toBe("unchanged");
  });

  it("lets a better read replace a worse stored one without asking", () => {
    const cur = { ...base, status: S.MissingPunch, finishTime: 5000, startTime: 1000 };
    expect(decideReadoutApply(cur, ok).outcome).toBe("apply");
  });
});
