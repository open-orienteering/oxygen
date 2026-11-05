/** The CONFLICT payload on the wire and the control `differing` rule (docs/course-layer.md §7). */

import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { versionConflictOf } from "@oxygen/shared";
import { withVersionConflict } from "../trpc.js";
import { controlFieldsDiff, versionConflict, baseVersionSchema } from "../version-conflict.js";

const shape = { message: "m", code: -32009, data: { code: "CONFLICT", httpStatus: 409, path: "course.update" } };

describe("withVersionConflict (errorFormatter)", () => {
  it("lifts the conflict into error.data beside tRPC's own fields", () => {
    const err = versionConflict({ kind: "course", id: 3, version: "123", current: { items: [] }, differing: ["31"] });
    const out = withVersionConflict(shape, err);
    expect(out.data).toEqual({ ...shape.data, kind: "course", id: 3, version: "123", current: { items: [] }, differing: ["31"] });
    expect(versionConflictOf(out.data)).toMatchObject({ kind: "course", version: "123" });
  });

  it("carries a course object's conflict the same way (§8.4: differing null)", () => {
    const err = versionConflict({ kind: "object", id: 7, version: "456", current: { kind: "whiteout" }, differing: null });
    const out = withVersionConflict(shape, err);
    expect(versionConflictOf(out.data)).toMatchObject({ kind: "object", id: 7, version: "456", current: { kind: "whiteout" }, differing: null });
    expect(versionConflictOf({ ...out.data, kind: "map" })).toBeNull();
  });

  it("leaves other errors — the duplicate-code CONFLICT among them — as they were", () => {
    const err = new TRPCError({ code: "CONFLICT", message: "Control with code 31 already exists" });
    expect(withVersionConflict(shape, err)).toBe(shape);
    expect(versionConflictOf(shape.data)).toBeNull();
  });
});

describe("controlFieldsDiff", () => {
  it("names the fields the base and the row disagree on, only among those the base has", () => {
    expect(controlFieldsDiff({ xpos: 1, ypos: 2, notes: "a" }, { xpos: 1, ypos: 3, notes: "b", codes: "31" })).toEqual(["ypos", "notes"]);
  });

  it("compares dates, JSON values and nulls by value", () => {
    const d = new Date("2026-10-31T10:00:00Z");
    expect(controlFieldsDiff({ checkedAt: d.toISOString(), description: { d: "1" }, circleGaps: null }, { checkedAt: d, description: { d: "1" }, circleGaps: null })).toEqual([]);
  });
});

describe("baseVersionSchema", () => {
  it("takes the decimal HLC string (it exceeds 2^53)", () => {
    expect(baseVersionSchema.parse("115344012345678901")).toBe("115344012345678901");
    expect(baseVersionSchema.safeParse(12).success).toBe(false);
    expect(baseVersionSchema.safeParse("-1").success).toBe(false);
  });
});
