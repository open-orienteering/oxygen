import { describe, it, expect, vi } from "vitest";
import { EditorConflict, EditorWrites, type EditorClient } from "../write-client";

function conflictError(data: object) {
  return Object.assign(new Error("CONFLICT"), { data: { code: "CONFLICT", ...data } });
}

function fakeClient() {
  const calls: { proc: string; input: Record<string, unknown> }[] = [];
  const queue: Array<() => unknown> = [];
  const respond = (proc: string) => async (input: Record<string, unknown>) => {
    calls.push({ proc, input });
    const next = queue.shift();
    return next ? next() : { version: "100" };
  };
  const client = {
    course: { setStructure: { mutate: vi.fn(respond("setStructure")) }, setControlLabelOffset: { mutate: vi.fn(respond("setLabelOffset")) } },
    control: { update: { mutate: vi.fn(respond("update")) }, delete: { mutate: vi.fn(respond("delete")) } },
  } as unknown as EditorClient;
  return { client, calls, fail: (e: unknown) => queue.push(() => { throw e; }), ok: (v: unknown) => queue.push(() => v) };
}

const S = { version: 1 as const, id: "c", orderMode: "ordered" as const, items: [{ siteId: 31 }] };

describe("EditorWrites (docs/course-editor.md §3)", () => {
  it("sends the newest token and advances it from the result", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("course", 1, "5");
    f.ok({ version: "6" });
    await w.setStructure(1, S);
    expect(f.calls[0].input.baseVersion).toBe("5");
    await w.setStructure(1, S);
    expect(f.calls[1].input.baseVersion).toBe("6");
  });

  it("a move against a description change elsewhere is re-sent once with the server's token", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("control", 31, "5");
    f.fail(conflictError({ kind: "control", id: 31, version: "9", current: { xpos: 10, ypos: 20 }, differing: ["description"] }));
    f.ok({ version: "10" });
    await w.updateControl({ id: 31, xpos: 15, ypos: 25, autoDescribe: true }, { x: 10, y: 20 });
    expect(f.calls.map((c) => c.input.baseVersion)).toEqual(["5", "9"]);
    expect(w.versions.get("control", 31)).toBe("10");
  });

  it("a move against another move throws `moved` with their position", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    f.fail(conflictError({ kind: "control", id: 31, version: "9", current: { xpos: 12, ypos: 20 }, differing: ["xpos"] }));
    const err = await w.updateControl({ id: 31, xpos: 15, ypos: 25 }, { x: 10, y: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EditorConflict);
    expect((err as EditorConflict).decision).toEqual({ kind: "moved", version: "9", theirs: { x: 12, y: 20 } });
    expect(f.calls).toHaveLength(1);
    // The book took the server's token: "keep mine" re-sends from it.
    expect(w.versions.get("control", 31)).toBe("9");
  });

  it("a stale structure throws `refresh` with the differing items, never re-sent", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    f.fail(conflictError({ kind: "course", id: 1, version: "9", current: {}, differing: ["32"] }));
    const err = await w.setStructure(1, S).catch((e: unknown) => e);
    expect((err as EditorConflict).decision).toEqual({ kind: "refresh", differing: ["32"] });
    expect(f.calls).toHaveLength(1);
  });

  it("other errors pass through", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    f.fail(new Error("boom"));
    await expect(w.setStructure(1, S)).rejects.toThrow("boom");
  });

  it("a code change re-keys the control's token; delete seeds the courses it advanced", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    f.ok({ version: "7" });
    await w.updateControl({ id: 31, codes: "45" });
    expect(w.versions.get("control", 45)).toBe("7");
    f.ok({ courses: [{ id: 1, version: "8" }] });
    await w.deleteControl(45);
    expect(w.versions.get("course", 1)).toBe("8");
  });
});
