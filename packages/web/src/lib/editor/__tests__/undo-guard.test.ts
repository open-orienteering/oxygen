import { describe, it, expect } from "vitest";
import { clearsNotice, createdControlElsewhere, writesRow, type EditorNotice, type ListedCourse } from "../undo-guard";

describe("clearsNotice: a success clears only a notice about its own row (CRS-065)", () => {
  const moved: EditorNotice = { kind: "moved", controlId: 40, mine: { x: 1, y: 1 }, theirs: { x: 2, y: 2 } };

  it("a moved notice survives an unrelated write and goes with a new move of its control", () => {
    expect(clearsNotice(moved, [{ kind: "course", id: 1, version: "9" }])).toBe(false);
    expect(clearsNotice(moved, [{ kind: "control", id: 40, version: "9" }])).toBe(false);
    expect(clearsNotice(moved, [], { controlId: 41 })).toBe(false);
    expect(clearsNotice(moved, [], { controlId: 40 })).toBe(true);
  });

  it("a queued move's notice goes only with its outbox entry", () => {
    expect(clearsNotice({ ...moved, queueSeq: 3 }, [], { controlId: 40 })).toBe(false);
  });

  it("a refresh goes with a write of its row; one without a row with any write", () => {
    const refresh: EditorNotice = { kind: "refresh", items: null, row: { kind: "course", id: 1 } };
    expect(clearsNotice(refresh, [{ kind: "course", id: 2, version: "9" }])).toBe(false);
    expect(clearsNotice(refresh, [{ kind: "course", id: 1, version: "9" }])).toBe(true);
    expect(clearsNotice({ kind: "refresh", items: null }, [])).toBe(true);
  });

  it("an undo-skipped notice stays until dismissed", () => {
    expect(clearsNotice({ kind: "undoSkipped", row: { kind: "course", id: 1 }, name: "Lång" }, [{ kind: "course", id: 1, version: "9" }])).toBe(false);
  });
});

describe("writesRow: the entries a skipped undo drops (D6)", () => {
  it("matches an entry by any of its rows", () => {
    expect(writesRow({ rows: [{ kind: "control", id: 31 }, { kind: "course", id: 1 }] }, { kind: "course", id: 1 })).toBe(true);
    expect(writesRow({ rows: [{ kind: "course", id: 2 }] }, { kind: "course", id: 1 })).toBe(false);
    expect(writesRow({}, { kind: "course", id: 1 })).toBe(false);
  });
});

describe("createdControlElsewhere: the created-control undo rule (D6)", () => {
  const c = (id: number, version: string, controls: string, parentCourseId: number | null = null): ListedCourse => ({ id, version, controls, parentCourseId });
  const book = (m: Record<number, string>) => (id: number) => m[id];

  it("another course visiting it blocks the undo, even after this client's own edit of that course", () => {
    const list = [c(1, "5", "45"), c(2, "9", "31;45")];
    // Also when Kort's token is this client's own (an edit and its undo since Anna added 45): no own-token exemption.
    expect(createdControlElsewhere(list, 45, 1, book({ 1: "5", 2: "9" }))?.id).toBe(2);
  });

  it("a row stale behind this client's newer token is not read (its own undo removed the visit)", () => {
    expect(createdControlElsewhere([c(2, "9", "45")], 45, null, book({ 2: "10" }))).toBeUndefined();
  });

  it("a variant is judged by its root: the entry's own course, a stale root or an own root token do not block", () => {
    const list = [c(1, "5", "45"), c(7, "3", "45", 1)];
    expect(createdControlElsewhere(list, 45, 1, book({ 1: "5", 7: "3" }))).toBeUndefined();
    // A free control appended to a course with variations, then undone quickly: root 1 is own / stale, list not refetched.
    expect(createdControlElsewhere([c(1, "5", ""), c(7, "3", "45", 1)], 45, null, book({ 1: "6", 7: "3" }))).toBeUndefined();
    // The root's row is current: a variant listing it means the course visits it now (a non-first alternative,
    // which the root's `controls` does not list), even when the root's token is this client's own.
    expect(createdControlElsewhere([c(2, "6", ""), c(7, "3", "45", 2)], 45, null, book({ 2: "6", 7: "3" }))?.id).toBe(7);
  });
});
