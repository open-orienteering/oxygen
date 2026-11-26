/**
 * Cloud-owned mutations in a batch of their own (row G18): the split
 * predicate, the link routing, and the export's best-effort ensure step on
 * an offline venue box.
 */

import { describe, expect, it } from "vitest";
import { createTRPCUntypedClient, type TRPCLink } from "@trpc/client";
import type { AnyTRPCRouter } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { cloudOwnedApart, ensureSheetsBestEffort, isCloudOwnedOp, isCloudUnreachable, isNetworkFailure, withRequestTimeout } from "../trpc-links";

describe("isCloudOwnedOp", () => {
  it("is a mutation on a cloud-owned path", () => {
    expect(isCloudOwnedOp({ type: "mutation", path: "courseObject.update" })).toBe(true);
    expect(isCloudOwnedOp({ type: "mutation", path: "layout.autoSheets" })).toBe(true);
    expect(isCloudOwnedOp({ type: "mutation", path: "club.update" })).toBe(true);
    expect(isCloudOwnedOp({ type: "query", path: "courseMap.list" })).toBe(false);
    expect(isCloudOwnedOp({ type: "mutation", path: "course.presence" })).toBe(false);
    expect(isCloudOwnedOp({ type: "mutation", path: "runner.update" })).toBe(false);
  });
});

describe("cloudOwnedApart", () => {
  it("sends cloud-owned mutations through their own link and everything else through the other", async () => {
    const made: string[][] = [];
    const make = (): TRPCLink<AnyTRPCRouter> => {
      const seen: string[] = [];
      made.push(seen);
      return () => ({ op }) =>
        observable((observer) => {
          seen.push(`${op.type} ${op.path}`);
          observer.next({ result: { type: "data", data: null } });
          observer.complete();
        });
    };
    const client = createTRPCUntypedClient<AnyTRPCRouter>({ links: [cloudOwnedApart(make)] });
    await Promise.all([
      client.mutation("courseObject.update", {}),
      client.mutation("course.presence", {}),
      client.query("courseMap.list", undefined),
      client.mutation("courseMap.saveLayout", {}),
    ]);
    expect(made).toEqual([
      ["mutation courseObject.update", "mutation courseMap.saveLayout"],
      ["mutation course.presence", "query courseMap.list"],
    ]);
  });
});

describe("ensureSheetsBestEffort", () => {
  const unreachable = Object.assign(new Error("requires connectivity"), { data: { code: "PRECONDITION_FAILED", httpStatus: 412, reason: "CLOUD_UNREACHABLE" } });
  const mixed = Object.assign(new Error("mixed"), { data: { code: "PRECONDITION_FAILED", reason: "MIXED_BATCH" } });
  const forbidden = Object.assign(new Error("no"), { data: { code: "FORBIDDEN" } });

  it("answers the step's result", async () => {
    expect(await ensureSheetsBestEffort(async () => ({ createdSheets: [1] }))).toEqual({ createdSheets: [1] });
  });

  it("skips the step when the venue's cloud is unreachable", async () => {
    expect(isCloudUnreachable(unreachable)).toBe(true);
    expect(
      await ensureSheetsBestEffort(async () => {
        throw unreachable;
      }),
    ).toBeNull();
  });

  it("skips the step on a network failure: no response (G17, offline print)", async () => {
    const noResponse = Object.assign(new Error("Failed to fetch"), { cause: new TypeError("Failed to fetch") });
    expect(isNetworkFailure(noResponse)).toBe(true);
    expect(isNetworkFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkFailure(forbidden)).toBe(false);
    expect(
      await ensureSheetsBestEffort(async () => {
        throw noResponse;
      }),
    ).toBeNull();
  });

  it("throws any other failure", async () => {
    for (const err of [mixed, forbidden, new Error("plain")]) {
      expect(isCloudUnreachable(err)).toBe(false);
      await expect(
        ensureSheetsBestEffort(async () => {
          throw err;
        }),
      ).rejects.toBe(err);
    }
  });
});

describe("isNetworkFailure: a request timeout (SYNC-11)", () => {
  it("counts a TimeoutError, bare or as the cause of a client error, as no answer", () => {
    const timeout = new DOMException("signal timed out", "TimeoutError");
    expect(isNetworkFailure(timeout)).toBe(true);
    expect(isNetworkFailure(Object.assign(new Error("signal timed out"), { cause: timeout }))).toBe(true);
  });
  it("does not count a deliberate abort", () => {
    expect(isNetworkFailure(new DOMException("aborted", "AbortError"))).toBe(false);
  });
});

describe("withRequestTimeout", () => {
  it("aborts a request that does not answer in time, as a TimeoutError", async () => {
    const hang = (_i: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)));
    const err = await withRequestTimeout(hang, 10)("/trpc/x").catch((e) => e);
    expect(err.name).toBe("TimeoutError");
    expect(isNetworkFailure(err)).toBe(true);
  });
  it("keeps the caller's own signal", async () => {
    const ctrl = new AbortController();
    const hang = (_i: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)));
    const pending = withRequestTimeout(hang, 10_000)("/trpc/x", { signal: ctrl.signal }).catch((e) => e);
    ctrl.abort(new DOMException("cancelled", "AbortError"));
    const err = await pending;
    expect(err.name).toBe("AbortError");
    expect(isNetworkFailure(err)).toBe(false);
  });
});
