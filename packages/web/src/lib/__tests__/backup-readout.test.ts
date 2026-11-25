import { describe, expect, it, vi } from "vitest";
import { runBackupFlow } from "../backup-readout";
import { BackupReadIncompleteError, type BackupResult } from "../webserial";
import { failureConcernsCurrentDetection } from "../read-failure";

const readoutBackup = (skipped: number): BackupResult => ({
  mode: "readout",
  records: [],
  skippedSlots: Array.from({ length: skipped }, (_, i) => ({
    slotAddress: 0x100 + i * 0x80,
    reason: "parse-failed" as const,
    rawBytesHex: "ee",
  })),
  stationSerial: 1,
  stationCode: 2,
});

function deps(over: Partial<Parameters<typeof runBackupFlow<number>>[0]> = {}) {
  const clear = vi.fn(async () => {});
  const importBackup = vi.fn(async () => 5);
  const read = vi.fn(async () => readoutBackup(0));
  return { clear, importBackup, read, d: { read, importBackup, clear, autoClear: true, ...over } };
}

describe("runBackupFlow: read -> import -> clear", () => {
  it("clears after a complete read and a successful import", async () => {
    const { d, clear } = deps();
    const r = await runBackupFlow(d);
    expect(r).toMatchObject({ outcome: "done", cleared: true, imported: 5 });
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("does not clear when auto-clear is off", async () => {
    const { d, clear } = deps({ autoClear: false });
    const r = await runBackupFlow(d);
    expect(r).toMatchObject({ outcome: "done", cleared: false });
    expect(clear).not.toHaveBeenCalled();
  });

  it("an incomplete read imports nothing and clears nothing", async () => {
    const { d, clear, importBackup } = deps({
      read: async () => {
        throw new BackupReadIncompleteError(0x300);
      },
    });
    const r = await runBackupFlow(d);
    expect(r.outcome).toBe("incomplete");
    expect(importBackup).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("a failed import does not clear", async () => {
    const boom = new Error("server down");
    const { d, clear } = deps({
      importBackup: async () => {
        throw boom;
      },
    });
    const r = await runBackupFlow(d);
    expect(r).toMatchObject({ outcome: "import-failed", error: boom });
    expect(clear).not.toHaveBeenCalled();
  });

  it("an import that deliberately took nothing (unknown control) does not clear", async () => {
    const { d, clear } = deps({ importBackup: async () => null });
    expect((await runBackupFlow(d)).outcome).toBe("not-imported");
    expect(clear).not.toHaveBeenCalled();
  });

  it("skipped slots: imported, reported, and NOT cleared", async () => {
    const { d, clear, importBackup } = deps({ read: async () => readoutBackup(2) });
    const r = await runBackupFlow(d);
    expect(importBackup).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ outcome: "done", cleared: false });
    if (r.outcome === "done") expect(r.skippedSlots).toHaveLength(2);
    expect(clear).not.toHaveBeenCalled();
  });

  it("a failing clear is reported as not cleared, not thrown", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { d } = deps({
      clear: async () => {
        throw new Error("no answer");
      },
    });
    expect(await runBackupFlow(d)).toMatchObject({ outcome: "done", cleared: false });
  });
});

describe("failureConcernsCurrentDetection", () => {
  it("same reader, or unknown ids: concerns it", () => {
    expect(failureConcernsCurrentDetection("a", "a")).toBe(true);
    expect(failureConcernsCurrentDetection(undefined, "a")).toBe(true);
    expect(failureConcernsCurrentDetection("a", null)).toBe(true);
  });
  it("another reader: does not", () => {
    expect(failureConcernsCurrentDetection("b", "a")).toBe(false);
  });
});
