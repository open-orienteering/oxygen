import { describe, expect, it } from "vitest";
import type { course } from "@oxygen/shared";
import { attachPatch, centrePatch, detachPatch, nearestSite, objectCentre, shownObject, shownObjects } from "../attach";

const obj = (over: Partial<course.CourseObject> = {}): course.CourseObject =>
  ({ id: 1, kind: "image", geometry: [{ x: 8, y: 8 }, { x: 12, y: 12 }], props: { graphicId: 1 }, scope: { all: true }, z: 0, version: "1", inCourses: null, ...over }) as course.CourseObject;

describe("attached objects in the editor (J10, docs/course-editor.md §7 \"Attached objects\")", () => {
  const pos = (id: number) => (id === 31 ? { x: 25, y: 20 } : null);
  it("shownObject moves an attached object to where it is drawn, its at the control's position; hidden without the control", () => {
    const o = obj({ attach: { controlId: 31, at: { x: 10, y: 10 } } });
    const shown = shownObject(o, pos)!;
    expect(shown.geometry).toEqual([{ x: 23, y: 18 }, { x: 27, y: 22 }]);
    expect(shown.attach).toEqual({ controlId: 31, at: { x: 25, y: 20 } });
    expect(shownObject(obj({ attach: { controlId: 32, at: { x: 0, y: 0 } } }), pos)).toBeNull();
    const plain = [obj()];
    expect(shownObjects(plain, pos)).toBe(plain);
    expect(shownObjects([o, obj({ id: 2, attach: { controlId: 32, at: { x: 0, y: 0 } } })], pos).map((x) => x.id)).toEqual([1]);
  });
  it("attach keeps the drawn place; centre moves it onto the control; detach keeps the drawn place without attach", () => {
    const o = obj();
    const site = { id: 31, x: 25, y: 20 };
    expect(attachPatch(o, site)).toEqual({ geometry: o.geometry, attach: { controlId: 31, at: { x: 25, y: 20 } } });
    expect(centrePatch(o, site).geometry).toEqual([{ x: 23, y: 18 }, { x: 27, y: 22 }]);
    expect(detachPatch(o)).toEqual({ geometry: o.geometry, attach: null });
  });
  it("a text centres by its anchor; the nearest site", () => {
    expect(objectCentre({ kind: "text", geometry: [{ x: 3, y: 4 }] })).toEqual({ x: 3, y: 4 });
    expect(nearestSite({ x: 0, y: 0 }, [{ id: 1, x: 5, y: 5 }, { id: 2, x: 1, y: 1 }])?.id).toBe(2);
    expect(nearestSite({ x: 0, y: 0 }, [])).toBeNull();
  });
});
