import { describe, expect, it } from "vitest";
import { defaultPromoteLabel, isPromoting, promoteErrorKey, promoteLabel, promoteOffer, type PromoteOfferInput } from "../modes/map/promote";

/** *Save corrections to the club map* (docs/course-editor.md §13 "Promote"; map-patches §5). */
const job = (state: "queued" | "running" | "done" | "failed") => ({ id: "j", state, stage: null, progress: 0, error: null });
const ok: PromoteOfferInput = { clubMapVersionId: "v1", canEdit: true, nodeRole: "cloud", job: null, correctionsOn: true, applicable: 2, writing: false };

describe("promote in Map mode", () => {
  it("is offered for a club-pinned map only", () => {
    expect(promoteOffer({ ...ok, clubMapVersionId: null })).toBeNull();
    expect(promoteOffer({ ...ok, clubMapVersionId: undefined })).toBeNull();
    expect(promoteOffer(ok)).toEqual({ block: null });
  });

  it("is disabled, in order: no courses.edit, a venue box, a promote running, corrections off, nothing applies, a write in flight", () => {
    const all: PromoteOfferInput = { ...ok, canEdit: false, nodeRole: "venue", job: job("running"), correctionsOn: false, applicable: 0, writing: true };
    expect(promoteOffer(all)?.block).toBe("readonly");
    expect(promoteOffer({ ...all, canEdit: true })?.block).toBe("venue");
    expect(promoteOffer({ ...all, canEdit: true, nodeRole: "cloud" })?.block).toBe("running");
    expect(promoteOffer({ ...all, canEdit: true, nodeRole: "cloud", job: job("done") })?.block).toBe("off");
    expect(promoteOffer({ ...all, canEdit: true, nodeRole: "cloud", job: job("failed"), correctionsOn: true })?.block).toBe("nothing");
    expect(promoteOffer({ ...all, canEdit: true, nodeRole: "cloud", job: null, correctionsOn: true, applicable: 1 })?.block).toBe("busy");
    // While lease.status loads the node is taken as the cloud's.
    expect(promoteOffer({ ...ok, nodeRole: undefined })?.block).toBeNull();
  });

  it("is running while queued or running", () => {
    expect(isPromoting(job("queued"))).toBe(true);
    expect(isPromoting(job("running"))).toBe(true);
    expect(isPromoting(job("done"))).toBe(false);
    expect(isPromoting(job("failed"))).toBe(false);
    expect(isPromoting(null)).toBe(false);
  });

  it("prefills the label with the event's name and date, cut to 200; a blank label is not sent", () => {
    expect(defaultPromoteLabel("Vårserien 3", "2026-11-16")).toBe("Vårserien 3 2026-11-16");
    expect(defaultPromoteLabel("Vårserien 3", "2026-11-16T00:00:00.000Z")).toBe("Vårserien 3 2026-11-16");
    expect(defaultPromoteLabel(" Name ", null)).toBe("Name");
    expect(defaultPromoteLabel("x".repeat(300), "2026-11-16")).toHaveLength(200);
    expect(promoteLabel("  a label  ")).toBe("a label");
    expect(promoteLabel("   ")).toBeNull();
  });

  it("says each refusal in its own words", () => {
    expect(promoteErrorKey(new Error("PATCH_NOT_LATEST: the club map has a newer version (3) than the event's (2)"))).toBe("promoteError_PATCH_NOT_LATEST");
    expect(promoteErrorKey(new Error("PATCH_NOT_CLUB_MAP: …"))).toBe("promoteError_PATCH_NOT_CLUB_MAP");
    expect(promoteErrorKey(new Error("PATCH_NOTHING_TO_PROMOTE: Apply corrections is off"))).toBe("promoteError_PATCH_NOTHING_TO_PROMOTE");
    expect(promoteErrorKey(new Error("PATCH_PROMOTING: …"))).toBe("promoteError_PATCH_PROMOTING");
    expect(promoteErrorKey(Object.assign(new Error("Sign in to save corrections to the club map"), { data: { code: "UNAUTHORIZED" } }))).toBe("promoteError_UNAUTHORIZED");
    expect(promoteErrorKey(new Error("Venue connectivity lost"))).toBe("promoteError_offline");
    expect(promoteErrorKey(new Error("something else"))).toBeNull();
  });
});
