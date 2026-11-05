import { describe, it, expect } from "vitest";
import type { VersionConflictData } from "@oxygen/shared";
import { conflictDecision, MOVE_FIELDS } from "../conflict";

const control = (differing: string[] | null, current: Record<string, unknown> = { xpos: 10, ypos: 20 }): VersionConflictData => ({
  kind: "control", id: 31, version: "99", current, differing,
});
const course = (differing: string[] | null): VersionConflictData => ({ kind: "course", id: 1, version: "99", current: {}, differing });

describe("conflictDecision (docs/course-layer.md §7 client rules)", () => {
  it("a field move rebases when the other side changed only fields the move does not touch", () => {
    for (const f of ["description", "codes", "notes", "kind", "circleGaps", "status", "name"]) {
      expect(conflictDecision(control([f]), { fields: MOVE_FIELDS, base: { x: 10, y: 20 } })).toEqual({ kind: "rebase", version: "99" });
    }
  });

  it("a field move against another move asks the user, with both positions", () => {
    expect(conflictDecision(control(["xpos"], { xpos: 12, ypos: 20 }), { fields: MOVE_FIELDS, base: { x: 10, y: 20 } })).toEqual({
      kind: "moved", version: "99", theirs: { x: 12, y: 20 },
    });
  });

  it("an unknown base (token 0, pruned) is decided by the current position", () => {
    expect(conflictDecision(control(null, { xpos: 10, ypos: 20 }), { fields: MOVE_FIELDS, base: { x: 10, y: 20 } }).kind).toBe("rebase");
    expect(conflictDecision(control(null, { xpos: 11, ypos: 20 }), { fields: MOVE_FIELDS, base: { x: 10, y: 20 } }).kind).toBe("moved");
  });

  it("another control write rebases on disjoint fields, otherwise refreshes", () => {
    expect(conflictDecision(control(["xpos"]), { fields: ["description"] })).toEqual({ kind: "rebase", version: "99" });
    expect(conflictDecision(control(["description"]), { fields: ["description"] })).toEqual({ kind: "refresh", differing: ["description"] });
    expect(conflictDecision(control(null), { fields: ["description"] })).toEqual({ kind: "refresh", differing: null });
  });

  it("a structure edit on a stale structure is never merged: refresh with the differing items", () => {
    expect(conflictDecision(course(["31", "32"]), { fields: ["structure"] })).toEqual({ kind: "refresh", differing: ["31", "32"] });
    expect(conflictDecision(course([]), { fields: ["structure"] })).toEqual({ kind: "refresh", differing: [] });
  });
});
