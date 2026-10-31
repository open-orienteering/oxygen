/** The legacy editor's version tokens and conflict detection (docs/course-layer.md §7 "Legacy editor"). */

import { describe, expect, it } from "vitest";
import { VersionBook, versionConflictOfError, publicIdAfterCodes } from "../version-book";

describe("VersionBook", () => {
  it("keeps the newest token per row, compared as integers (they exceed 2^53)", () => {
    const book = new VersionBook();
    book.seed("course", 3, "115344012345678901");
    book.seed("course", 3, "115344012345678900"); // an older refetch
    expect(book.get("course", 3)).toBe("115344012345678901");
    book.seed("course", 3, "115344012345678999");
    expect(book.get("course", 3)).toBe("115344012345678999");
    expect(book.get("control", 3)).toBeUndefined();
  });

  it("takes a mutation's returned token even when equal-length strings compare lexicographically wrong", () => {
    const book = new VersionBook();
    book.seed("control", 31, "99");
    book.seed("control", 31, "100");
    expect(book.get("control", 31)).toBe("100");
  });

  it("seeds a whole list", () => {
    const book = new VersionBook();
    book.seedAll("control", [{ id: 31, version: "5" }, { id: 32, version: "6" }]);
    expect(book.get("control", 32)).toBe("6");
  });
});

describe("versionConflictOfError", () => {
  it("reads the CONFLICT payload off a tRPC client error", () => {
    const err = Object.assign(new Error("changed"), {
      data: { code: "CONFLICT", httpStatus: 409, kind: "control", id: 31, version: "7", current: {}, differing: ["xpos"] },
    });
    expect(versionConflictOfError(err)).toMatchObject({ kind: "control", id: 31, version: "7" });
  });

  it("is null for other errors, the duplicate-code CONFLICT included", () => {
    expect(versionConflictOfError(new Error("x"))).toBeNull();
    expect(versionConflictOfError(Object.assign(new Error("dup"), { data: { code: "CONFLICT" } }))).toBeNull();
    expect(versionConflictOfError("nope")).toBeNull();
  });
});

describe("publicIdAfterCodes", () => {
  it("follows a control to its new public id when its first code changes", () => {
    expect(publicIdAfterCodes(31, "45;46")).toBe(45);
    expect(publicIdAfterCodes(31, undefined)).toBe(31);
    expect(publicIdAfterCodes(7, "")).toBe(7);
  });
});
