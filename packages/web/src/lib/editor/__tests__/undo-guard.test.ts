import { describe, it, expect } from "vitest";
import { clearsNotice, writesRow, type EditorNotice } from "../undo-guard";

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
