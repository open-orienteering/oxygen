import { beforeEach, describe, expect, it } from "vitest";
import type { course, CourseMapObject } from "@oxygen/shared";
import {
  CLIPBOARD_KEY, clearClipboardMemory, courseEntry, duplicateBody, pasteAt, pasteOnSite, pasteScope, readClipboard, refusal, writeClipboard,
  type ClipboardStore, type CourseEntry,
} from "../clipboard";

const store = (): ClipboardStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};
const square = (over: Partial<course.CourseObject> = {}): course.CourseObject =>
  ({ id: 4, kind: "oob_area", geometry: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 2 }], props: {}, scope: { all: true }, z: 0, version: "1", inCourses: null, ...over }) as course.CourseObject;

describe("the editor clipboard (J12, docs/course-editor.md §7 \"Duplicate, copy, cut, paste\")", () => {
  beforeEach(() => clearClipboardMemory());

  it("round-trips through storage; a corrupt or old entry reads empty; a throwing storage keeps the memory copy", () => {
    const s = store();
    const e = courseEntry(square(), "itest");
    writeClipboard(e, s);
    expect(readClipboard(s)).toEqual(e);
    s.data.set(CLIPBOARD_KEY, "{nope");
    expect(readClipboard(s)).toBeNull();
    s.data.set(CLIPBOARD_KEY, JSON.stringify({ ...e, v: 0 }));
    expect(readClipboard(s)).toBeNull();
    const broken: ClipboardStore = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    writeClipboard(e, broken);
    expect(readClipboard(broken)).toEqual(e);
    expect(readClipboard(null)).toEqual(e);
  });

  it("a full storage pastes the memory copy, not the older stored entry, until a write succeeds", () => {
    const s = store();
    const older = courseEntry(square({ kind: "whiteout" }), "itest");
    writeClipboard(older, s);
    const full: ClipboardStore = { getItem: s.getItem, setItem: () => { throw new Error("quota"); } };
    const newer = courseEntry(square(), "itest");
    writeClipboard(newer, full);
    expect(readClipboard(full)).toEqual(newer);
    writeClipboard(older, s);
    expect(readClipboard(s)).toEqual(older);
  });

  it("an entry a paste could not read is empty: no scope, bad points, a page object that is not one", () => {
    const s = store();
    const e = courseEntry(square(), "itest");
    const { scope: _scope, ...noScope } = e.object;
    for (const bad of [
      { ...e, object: noScope },
      { ...e, object: { ...e.object, geometry: [{ x: "a", y: 0 }] } },
      { ...e, object: { ...e.object, attach: { controlId: "x" } } },
      { v: 1, type: "page", event: "itest", object: { kind: "text" } },
    ]) {
      s.data.set(CLIPBOARD_KEY, JSON.stringify(bad));
      expect(readClipboard(s)).toBeNull();
    }
    const page = { id: "p", anchor: "page", kind: "text", x: 1, y: 1, text: "Hi", fontSizeMm: 3, color: "#000000" };
    s.data.set(CLIPBOARD_KEY, JSON.stringify({ v: 1, type: "page", event: "itest", object: page }));
    expect(readClipboard(s)?.type).toBe("page");
  });

  it("duplicate: 3 mm down-right on paper, an attachment kept", () => {
    const attach = { controlId: 31, at: { x: 1, y: 1 } };
    const d = duplicateBody(square({ attach }));
    expect(d.geometry[0]).toEqual({ x: 3, y: -3 });
    expect(d.attach).toEqual(attach);
    expect("attach" in duplicateBody(square())).toBe(false);
  });

  it("paste at a point centres the object there, free; onto a control at the copied offset or centred, attached", () => {
    const attached = courseEntry(square({ attach: { controlId: 31, at: { x: 10, y: 10 } } }), "itest").object;
    const free = courseEntry(square(), "itest").object;
    const at = pasteAt(attached, { x: 50, y: 50 });
    expect(at.geometry[0]).toEqual({ x: 48, y: 49 });
    expect(at.attach).toBeUndefined();
    const on = pasteOnSite(attached, { id: 32, x: 20, y: 30 });
    // The original sat (−10, −10) from its control: so does the copy from 32.
    expect(on.geometry[0]).toEqual({ x: 10, y: 20 });
    expect(on.attach).toEqual({ controlId: 32, at: { x: 20, y: 30 } });
    const centred = pasteOnSite(free, { id: 32, x: 20, y: 30 });
    expect(centred.geometry[0]).toEqual({ x: 18, y: 29 });
    expect(centred.attach).toEqual({ controlId: 32, at: { x: 20, y: 30 } });
  });

  it("scope (user answer 9): the original's when visible here in the same event, else the current course or all", () => {
    const scoped = courseEntry(square({ scope: { courses: [2], classes: [] }, inCourses: [2] }), "itest");
    expect(pasteScope(scoped, { event: "itest", drawnCourseIds: [2], currentCourseId: 2 })).toEqual({ courses: [2], classes: [] });
    expect(pasteScope(scoped, { event: "itest", drawnCourseIds: [3], currentCourseId: 3 })).toEqual({ courses: [3], classes: [] });
    expect(pasteScope(scoped, { event: "itest", drawnCourseIds: [], currentCourseId: null })).toEqual({ all: true });
    expect(pasteScope(scoped, { event: "other", drawnCourseIds: [2], currentCourseId: 2 })).toEqual({ courses: [2], classes: [] });
    const all = courseEntry(square(), "itest");
    expect(pasteScope(all, { event: "itest", drawnCourseIds: [3], currentCourseId: 3 })).toEqual({ all: true });
    expect(pasteScope(all, { event: "other", drawnCourseIds: [3], currentCourseId: 3 })).toEqual({ courses: [3], classes: [] });
    const parked = courseEntry(square({ scope: { courses: [], classes: [] }, inCourses: [] }), "itest");
    expect(pasteScope(parked, { event: "itest", drawnCourseIds: [], currentCourseId: null })).toEqual({ all: true });
  });

  it("refusals: the other mode's entry, a foreign graphic, another event's picked filter region, a toner saver onto controls", () => {
    const here = { event: "itest", mode: "course" as const, graphicIds: new Set([3]) };
    expect(refusal(courseEntry(square(), "itest"), here)).toBeNull();
    const page: CourseMapObject = { id: "p", anchor: "page", kind: "text", x: 1, y: 1, text: "Hi", fontSizeMm: 3 } as CourseMapObject;
    expect(refusal({ v: 1, type: "page", event: "itest", object: page }, here)).toBe("clipboardWrongType");
    expect(refusal(courseEntry(square(), "itest"), { ...here, mode: "page" })).toBe("clipboardWrongType");
    const img = (graphicId: number) => courseEntry(square({ kind: "image", geometry: [{ x: 0, y: 0 }, { x: 2, y: 1 }], props: { graphicId } } as Partial<course.CourseObject>), "itest");
    expect(refusal(img(3), here)).toBeNull();
    expect(refusal(img(9), here)).toBe("clipboardGraphicMissing");
    const region = (symbols: unknown): CourseEntry => courseEntry(square({ kind: "filter_region", props: { mode: "hide", symbols } } as Partial<course.CourseObject>), "other");
    expect(refusal(region([3]), here)).toBe("clipboardRegionForeign");
    expect(refusal(region("all"), here)).toBeNull();
    expect(refusal({ ...region([3]), event: "itest" }, here)).toBeNull();
    const toner = courseEntry(square({ kind: "toner_saver" }), "itest");
    expect(refusal(toner, { ...here, onControls: true })).toBe("clipboardUnattachable");
    expect(refusal(toner, here)).toBeNull();
  });
});
