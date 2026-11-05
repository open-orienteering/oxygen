import { describe, expect, it } from "vitest";
import { mapImportView } from "../map-import-view";

describe("mapImportView (docs/map-rendering.md §5.4)", () => {
  it("is pending while the job loads, is queued or runs", () => {
    expect(mapImportView(undefined)).toBe("pending");
    expect(mapImportView({ state: "queued", documentHash: null })).toBe("pending");
    expect(mapImportView({ state: "running", documentHash: null })).toBe("pending");
  });

  it("links the review for a finished job whose document is not pinned", () => {
    expect(mapImportView({ state: "done", documentHash: "a".repeat(64) })).toBe("review");
  });

  it("shows a failed job", () => {
    expect(mapImportView({ state: "failed", documentHash: null })).toBe("failed");
  });

  it("is unknown without a job, an unreadable one, or a done job without a document", () => {
    expect(mapImportView(null)).toBe("unknown");
    expect(mapImportView({ state: "done", documentHash: null })).toBe("unknown");
  });
});
