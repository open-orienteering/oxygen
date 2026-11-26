import { describe, expect, it } from "vitest";
import { shouldAutoPrint } from "../kiosk-print";

const runner = { id: 17, finishTime: 0 };
const receipt = { timing: { finishTime: 36_000 } };
const base = { alreadyPrinted: false, runner, receipt, runnerFresh: true, receiptFresh: true };

describe("shouldAutoPrint (WEB-02)", () => {
  it("prints once both answers are fresh and there is a finish", () => {
    expect(shouldAutoPrint(base)).toBe(true);
  });
  it("never prints from cached rows of an earlier read of the same card", () => {
    expect(shouldAutoPrint({ ...base, runnerFresh: false })).toBe(false);
    expect(shouldAutoPrint({ ...base, receiptFresh: false })).toBe(false);
  });
  it("prints at most once per screen", () => {
    expect(shouldAutoPrint({ ...base, alreadyPrinted: true })).toBe(false);
  });
  it("needs a finish time, stored or card-computed", () => {
    expect(shouldAutoPrint({ ...base, receipt: { timing: { finishTime: 0 } } })).toBe(false);
    expect(shouldAutoPrint({ ...base, runner: { id: 17, finishTime: 1 }, receipt: { timing: { finishTime: 0 } } })).toBe(true);
  });
  it("waits for both answers", () => {
    expect(shouldAutoPrint({ ...base, runner: undefined })).toBe(false);
    expect(shouldAutoPrint({ ...base, receipt: null })).toBe(false);
  });
});
