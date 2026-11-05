import { describe, it, expect } from "vitest";
import { courseActions, type ActionContext, type ActionHandlers } from "../ActionBar";

const noop = () => undefined;
const on: ActionHandlers = {
  insert: noop, addToCourse: noop, add: noop, addStart: noop, addFinish: noop, useAsRole: noop, append: noop,
  removeFromCourse: noop, resetLabel: noop, radio: noop, confirmSwap: noop, declineSwap: noop, description: noop, delete: noop,
};
const label = (k: string, o?: Record<string, string>) => (o?.name ? `${k}:${o.name}` : k);
const base: ActionContext = { phantom: null, selected: null, course: null, codesReady: true, busy: false };
const ids = (ctx: Partial<ActionContext>) => courseActions({ ...base, ...ctx }, on, label).map((a) => a.id);
const sel = (over: Partial<NonNullable<ActionContext["selected"]>> = {}) => ({
  id: 31, role: "control" as const, onCourse: false, otherRole: false, hasLabelOffset: false, radioOn: false, swapOffer: false, ...over,
});

describe("courseActions (the legacy popover's entries, docs/course-editor.md §4)", () => {
  it("empty map: add / start / finish, plus add-to-course with a course", () => {
    expect(ids({ phantom: { insertAt: null } })).toEqual(["add", "add-start", "add-finish"]);
    expect(ids({ phantom: { insertAt: null }, course: "Lång" })).toEqual(["add-to-course", "add", "add-start", "add-finish"]);
  });

  it("a leg: insert only", () => {
    expect(ids({ phantom: { insertAt: 2 }, course: "Lång" })).toEqual(["insert"]);
  });

  it("a control on the course", () => {
    expect(ids({ selected: sel({ onCourse: true, hasLabelOffset: true }), course: "Lång" }))
      .toEqual(["append", "remove-from-course", "reset-label", "radio", "description", "delete"]);
    expect(ids({ selected: sel() })).toEqual(["radio", "description", "delete"]);
  });

  it("a start that is not the course's: use as start; no radio", () => {
    expect(ids({ selected: sel({ role: "start", otherRole: true }), course: "Lång" })).toEqual(["use-as-start", "description", "delete"]);
  });

  it("an SRR swap offer replaces the radio entry; delete waits for a write in flight", () => {
    expect(ids({ selected: sel({ swapOffer: true }) })).toEqual(["radio-swap-confirm", "radio-swap-decline", "description", "delete"]);
    const del = courseActions({ ...base, selected: sel(), busy: true }, on, label).find((a) => a.id === "delete");
    expect(del?.disabled).toBe(true);
    expect(del?.variant).toBe("danger");
  });

  it("codes not loaded: the creating entries are disabled", () => {
    const acts = courseActions({ ...base, phantom: { insertAt: null }, codesReady: false }, on, label);
    expect(acts.find((a) => a.id === "add")?.disabled).toBe(true);
    expect(acts.find((a) => a.id === "add-start")?.disabled).toBeUndefined();
  });
});
