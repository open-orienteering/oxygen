import { describe, expect, it } from "vitest";
import { courseChange } from "../class-course";

describe("courseChange (WEB-09)", () => {
  it("the same course changes nothing and asks nothing", () => {
    expect(courseChange(3, 3, 12)).toEqual({ changed: false, confirm: false });
    expect(courseChange(null, null, 4)).toEqual({ changed: false, confirm: false });
  });
  it("a different course asks only when the class has runners", () => {
    expect(courseChange(3, 5, 0)).toEqual({ changed: true, confirm: false });
    expect(courseChange(3, 5, 2)).toEqual({ changed: true, confirm: true });
    expect(courseChange(null, 5, 1)).toEqual({ changed: true, confirm: true });
    expect(courseChange(3, null, 1)).toEqual({ changed: true, confirm: true });
  });
});
