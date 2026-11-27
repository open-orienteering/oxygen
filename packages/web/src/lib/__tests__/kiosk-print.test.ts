import { describe, expect, it } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { isFreshSince, shouldAutoPrint } from "../kiosk-print";

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

describe("isFreshSince", () => {
  it("is false for a cached row whose refetch failed (isFetchedAfterMount would be true)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = [["runner", "findByCard"], { input: { cardNo: 1 } }];
    qc.setQueryData(key, { id: 17, finishTime: 1 }, { updatedAt: 1_000 });
    const mountedAt = 2_000;
    const obs = new QueryObserver(qc, { queryKey: key, queryFn: async () => { throw new TypeError("Failed to fetch"); }, staleTime: 0 });
    const unsub = obs.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 10));
    const res = obs.getCurrentResult();
    expect(res.isFetchedAfterMount).toBe(true);
    expect(isFreshSince(res, mountedAt)).toBe(false);
    unsub();
  });
  it("is true once a fetch succeeded after the mount, false while one runs", () => {
    expect(isFreshSince({ isSuccess: true, isFetching: false, dataUpdatedAt: 2_500 }, 2_000)).toBe(true);
    expect(isFreshSince({ isSuccess: true, isFetching: true, dataUpdatedAt: 2_500 }, 2_000)).toBe(false);
    expect(isFreshSince({ isSuccess: true, isFetching: false, dataUpdatedAt: 1_500 }, 2_000)).toBe(false);
  });
});
