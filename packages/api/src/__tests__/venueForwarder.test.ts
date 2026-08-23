/**
 * Unit tests for the venue forwarder's request classification — which tRPC
 * requests a venue node sends upstream to the cloud (pivot Step 4).
 */

import { describe, it, expect } from "vitest";
import {
  trpcProcedurePaths,
  shouldForwardToCloud,
  connectivityErrorBody,
} from "../sync/venueForwarder.js";
import { isCloudOwnedMutation } from "../sync/ownership.js";

describe("trpcProcedurePaths", () => {
  it("parses a single procedure", () => {
    expect(trpcProcedurePaths("/trpc/club.update")).toEqual(["club.update"]);
  });

  it("parses a batched request", () => {
    expect(trpcProcedurePaths("/trpc/club.update,club.create?batch=1")).toEqual([
      "club.update",
      "club.create",
    ]);
  });

  it("ignores non-trpc URLs", () => {
    expect(trpcProcedurePaths("/api/backup/event?name=x")).toEqual([]);
    expect(trpcProcedurePaths("/health")).toEqual([]);
  });
});

describe("isCloudOwnedMutation", () => {
  it("classifies directory / integration / lifecycle paths as cloud-owned", () => {
    expect(isCloudOwnedMutation("club.update")).toBe(true);
    expect(isCloudOwnedMutation("eventor.syncEntries")).toBe(true);
    expect(isCloudOwnedMutation("tracks.deleteRoute")).toBe(true);
    expect(isCloudOwnedMutation("liveresults.enable")).toBe(true);
    expect(isCloudOwnedMutation("event.create")).toBe(true);
    expect(isCloudOwnedMutation("event.delete")).toBe(true);
  });

  it("keeps the race-critical and ambiguous set local", () => {
    expect(isCloudOwnedMutation("runner.update")).toBe(false);
    expect(isCloudOwnedMutation("race.recordFinish")).toBe(false);
    expect(isCloudOwnedMutation("cardReadout.storeReadout")).toBe(false);
    expect(isCloudOwnedMutation("events.push")).toBe(false);
    expect(isCloudOwnedMutation("lease.checkin")).toBe(false);
    expect(isCloudOwnedMutation("event.setCardFee")).toBe(false);
    expect(isCloudOwnedMutation("onlineInput.enable")).toBe(false);
  });
});

describe("shouldForwardToCloud", () => {
  it("forwards only POSTed cloud-owned procedures", () => {
    expect(shouldForwardToCloud("POST", "/trpc/club.update")).toBe(true);
    expect(shouldForwardToCloud("POST", "/trpc/eventor.syncEntries?batch=1")).toBe(
      true,
    );
    // Queries stay local (stale copy is fine by the boundary rule).
    expect(shouldForwardToCloud("GET", "/trpc/club.list")).toBe(false);
    // Race-critical mutations execute locally on the venue.
    expect(shouldForwardToCloud("POST", "/trpc/runner.update")).toBe(false);
    // A mixed batch executes locally — never split.
    expect(
      shouldForwardToCloud("POST", "/trpc/club.update,runner.update?batch=1"),
    ).toBe(false);
    expect(shouldForwardToCloud("POST", "/health")).toBe(false);
  });
});

describe("connectivityErrorBody", () => {
  it("shapes a tRPC error envelope, batched and unbatched", () => {
    const single = connectivityErrorBody(["club.update"], false) as {
      error: { data: { code: string; path: string } };
    };
    expect(single.error.data.code).toBe("PRECONDITION_FAILED");
    expect(single.error.data.path).toBe("club.update");

    const batched = connectivityErrorBody(
      ["club.update", "club.create"],
      true,
    ) as Array<{ error: { data: { path: string } } }>;
    expect(batched).toHaveLength(2);
    expect(batched[1].error.data.path).toBe("club.create");
  });
});
