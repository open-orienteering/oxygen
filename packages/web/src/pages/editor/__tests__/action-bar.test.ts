import { describe, it, expect, vi } from "vitest";
import { courseActions, type ActionContext, type ActionHandlers } from "../ActionBar";

const noop = () => undefined;
const on: ActionHandlers = {
  insert: noop, addBend: noop, addToCourse: noop, add: noop, addStart: noop, addFinish: noop, addMapIssue: noop, useAsRole: noop, append: noop,
  removeFromCourse: noop, resetLabel: noop, radio: noop, confirmSwap: noop, declineSwap: noop, description: noop, delete: noop,
};
const label = (k: string, o?: Record<string, string>) => (o?.name ? `${k}:${o.name}` : k);
const base: ActionContext = { phantom: null, selected: null, course: null, codesReady: true, busy: false };
const ids = (ctx: Partial<ActionContext>) => courseActions({ ...base, ...ctx }, on, label).map((a) => a.id);
const sel = (over: Partial<NonNullable<ActionContext["selected"]>> = {}) => ({
  id: 31, role: "control" as const, onCourse: false, otherRole: false, hasLabelOffset: false, radioOn: false, swapOffer: false, ...over,
});

describe("courseActions (the legacy popover's entries, docs/course-editor.md §4)", () => {
  it("empty map: add / start / finish / map-issue point (F4), plus add-to-course with a course", () => {
    expect(ids({ phantom: { insertAt: null } })).toEqual(["add", "add-start", "add-finish", "add-map-issue"]);
    expect(ids({ phantom: { insertAt: null }, course: "Lång" })).toEqual(["add-to-course", "add", "add-start", "add-finish", "add-map-issue"]);
    // F14: the map-issue point says what it is (§6.8).
    const entries = courseActions({ ...base, phantom: { insertAt: null } }, on, label);
    expect(entries.find((a) => a.id === "add-map-issue")!.title).toBe("editor:mapIssueHint");
    expect(entries.find((a) => a.id === "add")!.title).toBeUndefined();
  });

  it("a crossing or map-issue point: delete only (§6.8)", () => {
    expect(ids({ selected: sel({ mark: true }), course: "Lång" })).toEqual(["delete"]);
  });

  it("Add bend here hands the click's Alt to the page: Alt inserts a corner (§6.7, F16)", () => {
    const addBend = vi.fn();
    const entry = courseActions({ ...base, phantom: { insertAt: 2 }, course: "Lång", legEdit: true }, { ...on, addBend }, label).find((a) => a.id === "add-bend")!;
    entry.onClick({ altKey: true });
    expect(addBend).toHaveBeenCalledWith({ altKey: true });
  });

  it("a leg: insert, and add bend where the leg can be edited (§6.7)", () => {
    expect(ids({ phantom: { insertAt: 2 }, course: "Lång" })).toEqual(["insert"]);
    expect(ids({ phantom: { insertAt: 2 }, course: "Lång", legEdit: true })).toEqual(["insert", "add-bend"]);
  });

  it("a top-level leg: Create variation here, after add bend (§12, F7)", () => {
    const withCreate: ActionHandlers = { ...on, createVariation: noop };
    const list = (ctx: Partial<ActionContext>) => courseActions({ ...base, ...ctx }, withCreate, label).map((a) => a.id);
    expect(list({ phantom: { insertAt: 2 }, course: "Lång", legEdit: true, variationHere: true })).toEqual(["insert", "add-bend", "create-variation"]);
    // Inside or across a group, or on a phone (the page says no): not offered.
    expect(list({ phantom: { insertAt: 2 }, course: "Lång", legEdit: true })).toEqual(["insert", "add-bend"]);
    expect(list({ phantom: { insertAt: null }, course: "Lång", variationHere: true })).not.toContain("create-variation");
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
