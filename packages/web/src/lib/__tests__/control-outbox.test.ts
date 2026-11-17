import { describe, it, expect, vi } from "vitest";
import { TRPCClientError } from "@trpc/client";
import {
  CHANGED_ELSEWHERE,
  drain,
  discard,
  enqueue,
  enqueueInto,
  isNetworkFailure,
  memoryControlWriteStore,
  outboxCounts,
  overlayChecks,
  overlayCoordinates,
  resolveConflict,
  retry,
  type ControlMoveEntry,
  type ControlWrite,
  type ControlWriteStore,
  type DrainWrites,
} from "../offline/control-outbox";
import { EditorConflict } from "../editor/write-client";

const EV = "ev1";
const move = (id: number, to: [number, number], from?: [number, number], baseVersion?: string) => ({
  kind: "move" as const,
  input: { id, xpos: to[0], ypos: to[1], autoDescribe: true },
  from: from ? { x: from[0], y: from[1] } : undefined,
  baseVersion,
});
const check = (controlId: number, checked: boolean) => ({ kind: "check" as const, controlId, checked });

async function listOf(store: ControlWriteStore): Promise<ControlWrite[]> {
  return store.atomic((tx) => tx.list(EV));
}

/** A fake of the two `EditorWrites` calls the drain makes; each call takes the next scripted answer. */
function fakeWrites() {
  const calls: { proc: "move" | "check"; args: unknown[] }[] = [];
  const answers: Array<() => unknown> = [];
  let hook: (() => Promise<void>) | null = null;
  const next = async () => {
    if (hook) { const h = hook; hook = null; await h(); }
    const a = answers.shift();
    return (a ? a() : { version: "100" }) as { version: string };
  };
  const writes: DrainWrites = {
    updateControl: vi.fn(async (...args: unknown[]) => { calls.push({ proc: "move", args }); return next(); }) as DrainWrites["updateControl"],
    checkControl: vi.fn(async (...args: unknown[]) => { calls.push({ proc: "check", args }); return next(); }) as DrainWrites["checkControl"],
  };
  return {
    writes,
    calls,
    ok: (version: string) => answers.push(() => ({ version })),
    fail: (e: unknown) => answers.push(() => { throw e; }),
    /** Run `fn` while the next write is in flight. */
    during: (fn: () => Promise<void>) => { hook = fn; },
  };
}

const networkError = () => new TRPCClientError("Failed to fetch");
const serverError = (code: string, message: string) => Object.assign(new TRPCClientError(message), { data: { code } });

describe("enqueueInto: one move and one check entry per control (D9c, docs/course-editor.md §9 \"Offline\")", () => {
  it("a second move of the same control keeps the first `from` and token and takes the newest position", () => {
    const a = enqueueInto([], move(31, [11, 20], [10, 20], "5"), EV, 1);
    expect(a).toMatchObject({ add: { kind: "move", controlId: 31, from: { x: 10, y: 20 }, baseVersion: "5", status: "pending", rev: 0 } });
    const e: ControlWrite = { ...a.add!, seq: 1 };
    const b = enqueueInto([e], move(31, [12, 20], [11, 20], "5"), EV, 2);
    expect(b.put).toMatchObject({ seq: 1, input: { xpos: 12, ypos: 20 }, from: { x: 10, y: 20 }, baseVersion: "5", rev: 1 });
  });

  it("a move back to where the entry started drops it (an undo offline sends nothing)", () => {
    const e: ControlWrite = { ...enqueueInto([], move(31, [11, 20], [10, 20], "5"), EV, 1).add!, seq: 1 };
    expect(enqueueInto([e], move(31, [10, 20], [11, 20]), EV, 2)).toEqual({ delete: 1 });
  });

  it("an undo with a description merged into a move keeps it a pure move: position only, auto-described", () => {
    const e: ControlWrite = { ...enqueueInto([], move(31, [12, 20], [10, 20], "5"), EV, 1).add!, seq: 1 };
    const undo = { kind: "move" as const, input: { id: 31, xpos: 11, ypos: 20, description: { d: "stale" } } };
    expect(enqueueInto([e], undo, EV, 2).put).toEqual(expect.objectContaining({
      input: { id: 31, xpos: 11, ypos: 20, autoDescribe: true }, from: { x: 10, y: 20 }, baseVersion: "5",
    }));
  });

  it("a move merged into a plain write (an undo restoring a description) keeps it plain: the newest position, its description", () => {
    const undo = { kind: "move" as const, input: { id: 31, xpos: 10, ypos: 20, description: null }, baseVersion: "6" };
    const e: ControlWrite = { ...enqueueInto([], undo, EV, 1).add!, seq: 1 };
    const put = enqueueInto([e], move(31, [11, 20], [10, 20]), EV, 2).put as ControlMoveEntry;
    expect(put.input).toEqual({ id: 31, xpos: 11, ypos: 20, description: null });
    expect(put.from).toBeUndefined();
    expect(put.baseVersion).toBe("6");
    // A second undo's description wins.
    const again = enqueueInto([put], { kind: "move", input: { id: 31, xpos: 10, ypos: 20, description: { d: "x" } } }, EV, 3).put as ControlMoveEntry;
    expect(again.input).toEqual({ id: 31, xpos: 10, ypos: 20, description: { d: "x" } });
  });

  it("a check toggled back drops out; the same value again changes nothing", () => {
    const e: ControlWrite = { ...enqueueInto([], check(31, true), EV, 1).add!, seq: 1 };
    expect(enqueueInto([e], check(31, false), EV, 2)).toEqual({ delete: 1 });
    expect(enqueueInto([e], check(31, true), EV, 2)).toEqual({});
  });

  it("entries are per event and per control", () => {
    const e: ControlWrite = { ...enqueueInto([], move(31, [11, 20], [10, 20]), "other", 1).add!, seq: 1 };
    expect(enqueueInto([e], move(31, [12, 20], [11, 20]), EV, 2).add).toBeDefined();
    const f: ControlWrite = { ...enqueueInto([], move(32, [11, 20], [10, 20]), EV, 1).add!, seq: 2 };
    expect(enqueueInto([f], move(31, [12, 20], [11, 20]), EV, 2).add).toBeDefined();
    expect(enqueueInto([f], check(32, true), EV, 2).add).toBeDefined();
  });

  it("a new move of a control in conflict is pending again, from the server's position and token (Keep mine, moved on)", () => {
    const e = { ...enqueueInto([], move(31, [11, 20], [10, 20], "5"), EV, 1).add as ControlMoveEntry, seq: 1 };
    const c: ControlWrite = { ...e, status: "conflict", theirs: { x: 14, y: 20 }, serverVersion: "9" };
    expect(enqueueInto([c], move(31, [12, 20], [11, 20]), EV, 2).put).toMatchObject({
      status: "pending", from: { x: 14, y: 20 }, baseVersion: "9", input: { xpos: 12 }, theirs: undefined, serverVersion: undefined,
    });
  });

  it("an entry in flight is never dropped: the newer position replaces it and goes after", () => {
    const e: ControlWrite = { ...enqueueInto([], move(31, [11, 20], [10, 20], "5"), EV, 1).add!, seq: 1, sending: true };
    expect(enqueueInto([e], move(31, [10, 20], [11, 20]), EV, 2).put).toMatchObject({ input: { xpos: 10 }, rev: 1 });
    const c: ControlWrite = { ...enqueueInto([], check(31, true), EV, 1).add!, seq: 2, sending: true };
    expect(enqueueInto([c], check(31, false), EV, 2).put).toMatchObject({ checked: false, rev: 1 });
  });
});

describe("the own-writes overlay on the query cache", () => {
  const rows = [{ id: 31, mapX: 10, mapY: 20, code: "31" }, { id: 32, mapX: 30, mapY: 40, code: "32" }];

  it("puts queued moves where the setter left them; the same reference when nothing changes", () => {
    const e: ControlWrite = { ...enqueueInto([], move(31, [11, 21], [10, 20]), EV, 1).add!, seq: 1 };
    const out = overlayCoordinates(rows, [e]);
    expect(out).not.toBe(rows);
    expect(out[0]).toEqual({ id: 31, mapX: 11, mapY: 21, code: "31" });
    expect(out[1]).toBe(rows[1]);
    expect(overlayCoordinates(out, [e])).toBe(out);
    expect(overlayCoordinates(rows, [])).toBe(rows);
  });

  it("puts queued check-offs on the control list, keeping a stored time", () => {
    const list = [{ id: 31, checkedAt: null as string | null }, { id: 32, checkedAt: "2026-11-15T08:00:00.000Z" as string | null }];
    const on: ControlWrite = { ...enqueueInto([], check(31, true), EV, Date.parse("2026-11-15T09:00:00Z")).add!, seq: 1 };
    const off: ControlWrite = { ...enqueueInto([], check(32, false), EV, 2).add!, seq: 2 };
    const out = overlayChecks(list, [on, off]);
    expect(out.map((r) => r.checkedAt)).toEqual(["2026-11-15T09:00:00.000Z", null]);
    expect(overlayChecks(out, [on, off])).toBe(out);
  });

  it("counts entries by state", () => {
    const base = enqueueInto([], move(31, [11, 21], [10, 20]), EV, 1).add!;
    expect(outboxCounts([{ ...base, seq: 1 }, { ...base, seq: 2, status: "conflict" }, { ...base, seq: 3, status: "failed" }]))
      .toEqual({ total: 3, pending: 1, conflict: 1, failed: 1 });
  });
});

describe("isNetworkFailure: no server answer", () => {
  it("a tRPC client error without data is the network; one with data, or a conflict, is an answer", () => {
    expect(isNetworkFailure(networkError())).toBe(true);
    expect(isNetworkFailure(serverError("NOT_FOUND", "no control"))).toBe(false);
    expect(isNetworkFailure(new EditorConflict({ kind: "refresh", differing: null }, "control", 31))).toBe(false);
    expect(isNetworkFailure(new Error("boom"))).toBe(false);
  });
});

describe("drain: in order, under G1's rules (docs/course-editor.md §3, §9)", () => {
  it("sends entries in enqueue order, each move with the token and `from` it was queued with", async () => {
    const store = memoryControlWriteStore();
    await enqueue(store, EV, move(31, [11, 20], [10, 20], "5"));
    await enqueue(store, EV, check(32, true));
    await enqueue(store, EV, move(33, [1, 2], [0, 2], "7"));
    const f = fakeWrites();
    const onSent = vi.fn();
    const r = await drain(store, f.writes, EV, { onSent });
    expect(onSent.mock.calls.map(([e]) => e.controlId)).toEqual([31, 32, 33]);
    expect(f.calls.map((c) => c.proc)).toEqual(["move", "check", "move"]);
    expect(f.calls[0].args).toEqual([{ id: 31, xpos: 11, ypos: 20, autoDescribe: true }, { x: 10, y: 20 }, { baseVersion: "5" }]);
    expect(f.calls[1].args).toEqual([32, true]);
    expect(r).toEqual({ sent: 3, conflicts: 0, failed: 0, stopped: false });
    expect(await listOf(store)).toEqual([]);
  });

  it("moved elsewhere: the entry stays as a conflict with their position and the server's token; the rest go on", async () => {
    const store = memoryControlWriteStore();
    await enqueue(store, EV, move(31, [11, 20], [10, 20], "5"));
    await enqueue(store, EV, check(32, true));
    const f = fakeWrites();
    f.fail(new EditorConflict({ kind: "moved", version: "9", theirs: { x: 14, y: 20 } }, "control", 31));
    const r = await drain(store, f.writes, EV);
    expect(r).toMatchObject({ sent: 1, conflicts: 1 });
    expect(await listOf(store)).toEqual([expect.objectContaining({ controlId: 31, status: "conflict", theirs: { x: 14, y: 20 }, serverVersion: "9", sending: false })]);
    // Keep mine: pending again from their position on the server's token; the next drain sends it.
    const [c] = await listOf(store);
    await resolveConflict(store, c.seq!, "mine");
    await drain(store, f.writes, EV);
    expect(f.calls[2].args).toEqual([{ id: 31, xpos: 11, ypos: 20, autoDescribe: true }, { x: 14, y: 20 }, { baseVersion: "9" }]);
    expect(await listOf(store)).toEqual([]);
  });

  it("Keep theirs drops the entry", async () => {
    const store = memoryControlWriteStore();
    await enqueue(store, EV, move(31, [11, 20], [10, 20], "5"));
    const f = fakeWrites();
    f.fail(new EditorConflict({ kind: "moved", version: "9", theirs: { x: 14, y: 20 } }, "control", 31));
    await drain(store, f.writes, EV);
    await resolveConflict(store, (await listOf(store))[0].seq!, "theirs");
    expect(await listOf(store)).toEqual([]);
  });

  it("a `moved` answer at our own position is our write landing before its answer was lost: done", async () => {
    const store = memoryControlWriteStore();
    await enqueue(store, EV, move(31, [11, 20], [10, 20], "5"));
    const f = fakeWrites();
    f.fail(new EditorConflict({ kind: "moved", version: "9", theirs: { x: 11, y: 20 } }, "control", 31));
    expect(await drain(store, f.writes, EV)).toMatchObject({ sent: 1, conflicts: 0 });
    expect(await listOf(store)).toEqual([]);
  });

  it("a rejection marks the entry failed with its message and goes on; Retry sends it on the book's token, Discard drops it", async () => {
    const store = memoryControlWriteStore();
    await enqueue(store, EV, move(31, [11, 20], [10, 20], "5"));
    await enqueue(store, EV, check(32, true));
    const f = fakeWrites();
    f.fail(serverError("FORBIDDEN", "checked out to venue"));
    const r = await drain(store, f.writes, EV);
    expect(r).toMatchObject({ sent: 1, failed: 1 });
    const [e] = await listOf(store);
    expect(e).toMatchObject({ status: "failed", error: "checked out to venue", attempts: 1 });
    await retry(store, e.seq!);
    await drain(store, f.writes, EV);
    expect(f.calls[2].args[2]).toEqual({ baseVersion: undefined });
    await enqueue(store, EV, check(33, true));
    f.fail(serverError("NOT_FOUND", "gone"));
    await drain(store, f.writes, EV);
    const [g] = await listOf(store);
    await discard(store, g.seq!);
    expect(await listOf(store)).toEqual([]);
  });

  it("a write that cannot be merged (`refresh`) fails as changed elsewhere", async () => {
    const store = memoryControlWriteStore();
    await enqueue(store, EV, { kind: "move", input: { id: 31, xpos: 10, ypos: 20, description: null } });
    const f = fakeWrites();
    f.fail(new EditorConflict({ kind: "refresh", differing: ["description"] }, "control", 31));
    await drain(store, f.writes, EV);
    expect((await listOf(store))[0]).toMatchObject({ status: "failed", error: CHANGED_ELSEWHERE });
  });

  it("replay classes a plain write as one (no `from`): `EditorWrites` decides it by its fields, never by the move rule", async () => {
    const store = memoryControlWriteStore();
    await enqueue(store, EV, { kind: "move", input: { id: 31, xpos: 10, ypos: 20, description: null }, baseVersion: "6" });
    await enqueue(store, EV, move(31, [11, 20], [10, 20]));
    const f = fakeWrites();
    await drain(store, f.writes, EV);
    expect(f.calls[0].args).toEqual([{ id: 31, xpos: 11, ypos: 20, description: null }, undefined, { baseVersion: "6" }]);
  });

  it("a flag left in flight by a closed tab is cleared when a drain starts", async () => {
    const store = memoryControlWriteStore();
    await enqueue(store, EV, check(31, true));
    const [e] = await listOf(store);
    await store.atomic((tx) => tx.put({ ...e, sending: true }));
    const f = fakeWrites();
    f.fail(networkError());
    await drain(store, f.writes, EV);
    expect((await listOf(store))[0].sending).toBe(false);
  });

  it("a network failure stops the drain and keeps that entry and the rest pending", async () => {
    const store = memoryControlWriteStore();
    await enqueue(store, EV, move(31, [11, 20], [10, 20], "5"));
    await enqueue(store, EV, check(32, true));
    const f = fakeWrites();
    f.fail(networkError());
    const r = await drain(store, f.writes, EV);
    expect(r).toEqual({ sent: 0, conflicts: 0, failed: 0, stopped: true });
    expect(f.calls).toHaveLength(1);
    expect((await listOf(store)).map((e) => [e.status, e.sending])).toEqual([["pending", false], ["pending", undefined]]);
  });

  it("a move made while its entry is in flight goes out after it, on the token that write returned", async () => {
    const store = memoryControlWriteStore();
    await enqueue(store, EV, move(31, [11, 20], [10, 20], "5"));
    const f = fakeWrites();
    f.ok("6");
    f.during(async () => { await enqueue(store, EV, move(31, [10, 20], [11, 20])); });
    const r = await drain(store, f.writes, EV);
    expect(r?.sent).toBe(2);
    expect(f.calls[1].args).toEqual([{ id: 31, xpos: 10, ypos: 20, autoDescribe: true }, { x: 11, y: 20 }, { baseVersion: "6" }]);
    expect(await listOf(store)).toEqual([]);
  });

  it("a check toggled back while in flight sends the newer value after it", async () => {
    const store = memoryControlWriteStore();
    await enqueue(store, EV, check(31, true));
    const f = fakeWrites();
    f.during(async () => { await enqueue(store, EV, check(31, false)); });
    await drain(store, f.writes, EV);
    expect(f.calls.map((c) => c.args)).toEqual([[31, true], [31, false]]);
    expect(await listOf(store)).toEqual([]);
  });

  it("a second drain of the same event while one runs does nothing", async () => {
    const store = memoryControlWriteStore();
    await enqueue(store, EV, check(31, true));
    const f = fakeWrites();
    let second: Promise<unknown> | null = null;
    f.during(async () => { second = drain(store, f.writes, EV); });
    await drain(store, f.writes, EV);
    expect(await second).toBeNull();
    expect(f.calls).toHaveLength(1);
  });
});
