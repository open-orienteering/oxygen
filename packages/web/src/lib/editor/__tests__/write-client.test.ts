import { describe, it, expect, vi } from "vitest";
import { EditorConflict, EditorWrites, UndoSkipped, type EditorClient } from "../write-client";

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
    course: {
      setStructure: { mutate: vi.fn(respond("setStructure")) },
      setControlLabelOffset: { mutate: vi.fn(respond("setLabelOffset")) },
      update: { mutate: vi.fn(respond("courseUpdate")) },
    },
    control: { update: { mutate: vi.fn(respond("update")) }, delete: { mutate: vi.fn(respond("delete")) }, check: { mutate: vi.fn(respond("check")) } },
    courseObject: {
      create: { mutate: vi.fn(respond("objCreate")) },
      update: { mutate: vi.fn(respond("objUpdate")) },
      delete: { mutate: vi.fn(respond("objDelete")) },
    },
    mapPatch: {
      applyChange: { mutate: vi.fn(respond("patchApply")) },
      setEnabled: { mutate: vi.fn(respond("patchEnabled")) },
      attachUnresolved: { mutate: vi.fn(respond("patchAttach")) },
    },
    mapTrack: {
      import: { mutate: vi.fn(respond("trackImport")) },
      update: { mutate: vi.fn(respond("trackUpdate")) },
      split: { mutate: vi.fn(respond("trackSplit")) },
      remove: { mutate: vi.fn(respond("trackRemove")) },
      markConverted: { mutate: vi.fn(respond("trackConverted")) },
    },
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

  it("remembers the course tokens its own writes returned (D11: anything else moved elsewhere)", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    f.ok({ version: "6" });
    await w.setStructure(1, S);
    f.ok({ version: "7" });
    await w.setLabelOffset(1, 31, null);
    f.ok({ courses: [{ id: 2, version: "8" }] });
    await w.deleteControl(31);
    expect([...w.ownCourseVersions].sort()).toEqual(["6", "7", "8"]);
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

  it("a queued move sends the token it was queued with, not the book's newer one (D9c, §9 \"Offline\")", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("control", 31, "12");
    f.fail(conflictError({ kind: "control", id: 31, version: "12", current: { xpos: 10, ypos: 20 }, differing: ["checkedAt", "checkedBy"] }));
    f.ok({ version: "13" });
    await w.updateControl({ id: 31, xpos: 15, ypos: 25, autoDescribe: true }, { x: 10, y: 20 }, { baseVersion: "5" });
    // The stale base answers CONFLICT; only a check changed there, so it rebases once on the server's token.
    expect(f.calls.map((c) => c.input.baseVersion)).toEqual(["5", "12"]);
    expect(w.versions.get("control", 31)).toBe("13");
    // Moved there too: `moved`, as without the override.
    w.versions.seed("control", 31, "20");
    f.fail(conflictError({ kind: "control", id: 31, version: "20", current: { xpos: 11, ypos: 20 }, differing: ["xpos"] }));
    const err = await w.updateControl({ id: 31, xpos: 16, ypos: 25 }, { x: 15, y: 25 }, { baseVersion: "13" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EditorConflict);
    expect(f.calls[2].input.baseVersion).toBe("13");
  });

  it("a stale structure throws `refresh` with the differing items, never re-sent", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    f.fail(conflictError({ kind: "course", id: 1, version: "9", current: {}, differing: ["32"] }));
    const err = await w.setStructure(1, S).catch((e: unknown) => e);
    expect((err as EditorConflict).decision).toEqual({ kind: "refresh", differing: ["32"] });
    expect(f.calls).toHaveLength(1);
  });

  it("description instructions: course.update with the course's token, the result seeds it and counts as own (E3b)", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("course", 1, "5");
    f.ok({ ok: true, version: "6" });
    await w.setInstructions(1, { finish: { kind: "14.1" } });
    expect(f.calls[0]).toEqual({ proc: "courseUpdate", input: { id: 1, descriptionInstructions: { finish: { kind: "14.1" } }, baseVersion: "5" } });
    expect(w.versions.get("course", 1)).toBe("6");
    expect(w.ownCourseVersions.has("6")).toBe(true);
    // Undo clears the column: null is sent as null, on the token the first write returned.
    f.ok({ ok: true, version: "7" });
    await w.setInstructions(1, null);
    expect(f.calls[1].input).toEqual({ id: 1, descriptionInstructions: null, baseVersion: "6" });
  });

  it("description instructions on a stale token: `refresh`, never re-sent, the server's token kept (E3b)", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("course", 1, "5");
    f.fail(conflictError({ kind: "course", id: 1, version: "9", current: {}, differing: [] }));
    const err = await w.setInstructions(1, { finish: { kind: "14.2" } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EditorConflict);
    expect((err as EditorConflict).decision.kind).toBe("refresh");
    expect(f.calls).toHaveLength(1);
    expect(w.versions.get("course", 1)).toBe("9");
  });

  /** A client whose `setStructure` answers only when the test resolves it, so two writes can overlap. */
  function heldClient() {
    const sent: { baseVersion: unknown; answer: (v: unknown) => void; refuse: (e: unknown) => void }[] = [];
    const mutate = vi.fn((input: Record<string, unknown>) => new Promise((answer, refuse) => sent.push({ baseVersion: input.baseVersion, answer, refuse })));
    const client = {
      course: { setStructure: { mutate }, setControlLabelOffset: { mutate }, update: { mutate } },
      control: { update: { mutate } },
    } as unknown as EditorClient;
    return { client, sent };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("a write made while one of the same course is in flight waits for it and sends its token (Ctrl+Z twice, bugfix-editor-overlapping-course-writes)", async () => {
    const h = heldClient();
    const w = new EditorWrites(h.client);
    w.versions.seed("course", 1, "5");
    const first = w.setStructure(1, S);
    const second = w.setStructure(1, S);
    const label = w.setLabelOffset(1, 31, null);
    await settle();
    // One in flight: the second is not sent before the first's reply has seeded its token.
    expect(h.sent.map((s) => s.baseVersion)).toEqual(["5"]);
    h.sent[0].answer({ version: "6" });
    await first;
    await settle();
    expect(h.sent.map((s) => s.baseVersion)).toEqual(["5", "6"]);
    h.sent[1].answer({ version: "7" });
    await second;
    await settle();
    // The label offset takes no token but advances the course's: it queues as a course write.
    expect(h.sent).toHaveLength(3);
    h.sent[2].answer({ version: "8" });
    await label;
    expect(w.versions.get("course", 1)).toBe("8");
  });

  it("a refused write does not stop the queue: the next sends the token the refusal seeded", async () => {
    const h = heldClient();
    const w = new EditorWrites(h.client);
    w.versions.seed("course", 1, "5");
    const first = w.setStructure(1, S).catch((e: unknown) => e);
    const second = w.setStructure(1, S);
    await settle();
    h.sent[0].refuse(conflictError({ kind: "course", id: 1, version: "9", current: {}, differing: ["32"] }));
    expect(await first).toBeInstanceOf(EditorConflict);
    await settle();
    expect(h.sent.map((s) => s.baseVersion)).toEqual(["5", "9"]);
    h.sent[1].answer({ version: "10" });
    await expect(second).resolves.toEqual({ version: "10" });
  });

  it("writes of different rows do not wait for each other", async () => {
    const h = heldClient();
    const w = new EditorWrites(h.client);
    void w.setStructure(1, S);
    void w.setStructure(2, S);
    void w.updateControl({ id: 31, xpos: 1, ypos: 2 });
    await settle();
    expect(h.sent).toHaveLength(3);
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

  it("course objects: create seeds the token, update sends it, a stale one is a refresh (§7)", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    f.ok({ id: 9, version: "40" });
    await w.createObject({ kind: "whiteout", geometry: [], props: {}, scope: { all: true } });
    f.ok({ id: 9, version: "41" });
    await w.updateObject({ id: 9, props: {} });
    expect(f.calls[1]).toMatchObject({ proc: "objUpdate", input: { id: 9, baseVersion: "40" } });
    expect(w.versions.get("object", 9)).toBe("41");
    f.fail(conflictError({ kind: "object", id: 9, version: "50", current: {}, differing: null }));
    await expect(w.deleteObject(9)).rejects.toBeInstanceOf(EditorConflict);
    expect(f.calls[2]).toMatchObject({ proc: "objDelete", input: { id: 9, baseVersion: "41" } });
    expect(w.versions.get("object", 9)).toBe("50");
  });

  it("createObjects creates in order; a failure deletes the ones made and rethrows (J12)", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    const body = { kind: "whiteout" as const, geometry: [], props: {}, scope: { all: true as const } };
    f.ok({ id: 1, version: "1" });
    f.ok({ id: 2, version: "2" });
    expect((await w.createObjects([body, body])).map((o) => o.id)).toEqual([1, 2]);
    f.ok({ id: 3, version: "3" });
    f.fail(new Error("boom"));
    f.ok({});
    await expect(w.createObjects([body, body])).rejects.toThrow("boom");
    expect(f.calls.at(-1)).toMatchObject({ proc: "objDelete", input: { id: 3, baseVersion: "3" } });
  });

  it("updateObjects and deleteObjects run in order; a failure puts the done ones back and rethrows (J16)", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("object", 1, "1");
    w.versions.seed("object", 2, "2");
    const g = (x: number) => [{ x, y: 0 }];
    f.ok({ id: 1, version: "3" });
    f.fail(new Error("boom"));
    f.ok({ id: 1, version: "4" });
    await expect(w.updateObjects([
      { input: { id: 1, geometry: g(5) }, undo: { id: 1, geometry: g(0) } },
      { input: { id: 2, geometry: g(5) }, undo: { id: 2, geometry: g(0) } },
    ])).rejects.toThrow("boom");
    expect(f.calls.at(-1)).toMatchObject({ proc: "objUpdate", input: { id: 1, geometry: g(0), baseVersion: "3" } });
    const body = { kind: "whiteout" as const, geometry: [], props: {}, scope: { all: true as const } };
    f.ok({});
    f.fail(new Error("gone"));
    f.ok({ id: 9, version: "1" });
    await expect(w.deleteObjects([{ id: 1, body }, { id: 2, body }])).rejects.toThrow("gone");
    expect(f.calls.at(-1)).toMatchObject({ proc: "objCreate", input: body });
  });

  it("check-off sends no token and seeds the control's from the result (§9)", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("control", 31, "5");
    f.ok({ version: "9" });
    await w.checkControl(31, true);
    expect(f.calls[0]).toEqual({ proc: "check", input: { controlId: 31, checked: true } });
    await w.updateControl({ id: 31, xpos: 1, ypos: 2 });
    expect(f.calls[1].input.baseVersion).toBe("9");
  });

  it("map patch writes carry the document hash and no token; the reply is returned, a refusal propagates (§13)", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    f.ok({ version: "7", patch: null });
    const res = await w.applyPatchChange("ab".repeat(32), { put: [{ op: "hide", sourceIndex: 4 }] });
    expect(res).toEqual({ version: "7", patch: null });
    expect(f.calls[0]).toEqual({ proc: "patchApply", input: { documentHash: "ab".repeat(32), put: [{ op: "hide", sourceIndex: 4 }] } });
    f.ok({ version: "8", patch: null });
    await w.setPatchEnabled(false);
    expect(f.calls[1]).toEqual({ proc: "patchEnabled", input: { enabled: false } });
    f.fail(new Error("PATCH_STALE: the patch is keyed to another document"));
    await expect(w.applyPatchChange("ab".repeat(32), { remove: ["hide:4"] })).rejects.toThrow(/PATCH_STALE/);
    expect(f.calls).toHaveLength(3);
    // G12b: *Attach* with an object, or with a picked symbol and no object.
    f.ok({ version: "9", patch: null });
    await w.attachUnresolvedPatch("ab".repeat(32), "k1", { sourceIndex: 5 });
    expect(f.calls[3]).toEqual({ proc: "patchAttach", input: { documentHash: "ab".repeat(32), key: "k1", sourceIndex: 5 } });
    f.ok({ version: "10", patch: null });
    await w.attachUnresolvedPatch("ab".repeat(32), "k2", { symbol: { patch: "ISOM2017-2:204" } });
    expect(f.calls[4]).toEqual({ proc: "patchAttach", input: { documentHash: "ab".repeat(32), key: "k2", symbol: { patch: "ISOM2017-2:204" } } });
  });

  it("GPS track writes pass their input through and return the reply; a refusal propagates (docs/map-gps-tracks.md §5.1)", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    const points = { lat: [1, 2], lng: [3, 4], time: null, ele: null };
    f.ok({ tracks: [{ id: "t1" }] });
    expect(await w.importTracks([{ name: "A", sourceName: "a.gpx", points }])).toEqual({ tracks: [{ id: "t1" }] });
    expect(f.calls[0]).toEqual({ proc: "trackImport", input: { tracks: [{ name: "A", sourceName: "a.gpx", points }] } });
    f.ok({ id: "t1", name: "B" });
    await w.updateTrack({ id: "t1", name: "B" });
    expect(f.calls[1]).toEqual({ proc: "trackUpdate", input: { id: "t1", name: "B" } });
    f.ok({ removed: 1 });
    expect(await w.removeTracks(["t1"])).toEqual({ removed: 1 });
    expect(f.calls[2]).toEqual({ proc: "trackRemove", input: { ids: ["t1"] } });
    f.ok({ tracks: [] });
    await w.markTracksConverted([{ id: "t1", opId: null }]);
    expect(f.calls[3]).toEqual({ proc: "trackConverted", input: { marks: [{ id: "t1", opId: null }] } });
    f.fail(new Error("TRACK_LIMIT: the event would hold more than 200 tracks"));
    await expect(w.importTracks([{ name: null, sourceName: "b.gpx", points }])).rejects.toThrow(/TRACK_LIMIT/);
    // G27: split with the client's part ids.
    f.ok({ tracks: [{ id: "l" }, { id: "r" }] });
    expect(await w.splitTrack({ id: "t1", index: 3, ids: ["l", "r"] })).toEqual({ tracks: [{ id: "l" }, { id: "r" }] });
    expect(f.calls.at(-1)).toEqual({ proc: "trackSplit", input: { id: "t1", index: 3, ids: ["l", "r"] } });
    f.fail(new Error("TRACK_SPLIT_INVALID: index 1 leaves fewer than two points"));
    await expect(w.splitTrack({ id: "t1", index: 1, ids: ["l", "r"] })).rejects.toThrow(/TRACK_SPLIT_INVALID/);
  });

  it("without a mapTrack client the track writes refuse", async () => {
    const f = fakeClient();
    const w = new EditorWrites({ ...f.client, mapTrack: undefined });
    expect(() => w.removeTracks(["t1"])).toThrow(/not available/);
    expect(() => w.splitTrack({ id: "t1", index: 3, ids: ["l", "r"] })).toThrow(/not available/);
  });

  it("without a mapPatch client the patch writes refuse", async () => {
    const f = fakeClient();
    const w = new EditorWrites({ ...f.client, mapPatch: undefined });
    expect(() => w.setPatchEnabled(true)).toThrow(/not available/);
  });
});

describe("EditorWrites: own chain and the D6 undo guard (docs/course-editor.md §3)", () => {
  const courseConflict = (version: string) => conflictError({ kind: "course", id: 1, version, differing: ["31"] });

  it("the chain links each own result to the token it was sent on; stillMine follows it, a foreign token breaks it", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("course", 1, "5");
    f.ok({ version: "6" });
    f.ok({ version: "7" });
    await w.setStructure(1, S);
    await w.setLabelOffset(1, 31, { dx: 1, dy: 0 });
    expect(w.chainEnd("course", 1, "5")).toBe("7");
    expect(w.stillMine("course", 1, "6")).toBe(true);
    w.versions.seed("course", 1, "8"); // someone else's write, seen by the poll
    expect(w.stillMine("course", 1, "6")).toBe(false);
  });

  it("own → foreign → own does not count as mine: the own write after the foreign one links from the foreign token", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("course", 1, "5");
    f.ok({ version: "6" });
    await w.setStructure(1, S);
    w.versions.seed("course", 1, "7");
    f.ok({ version: "8" });
    await w.setStructure(1, S);
    expect(w.versions.get("course", 1)).toBe("8");
    expect(w.stillMine("course", 1, "6")).toBe(false);
    expect(w.stillMine("course", 1, "7")).toBe(true);
  });

  it("a structure built on an older token is sent on it, not on the newer one course.list seeded (CRS-049)", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("course", 1, "5");
    w.versions.seed("course", 1, "6"); // B's write, from the list refetch; the detail still says 5
    f.fail(courseConflict("6"));
    await expect(w.setStructure(1, S, { since: "5" })).rejects.toBeInstanceOf(EditorConflict);
    expect(f.calls[0].input.baseVersion).toBe("5");
  });

  it("collect returns the rows the call's own writes produced, the last token per row", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    f.ok({ version: "6" });
    f.ok({ version: "7" });
    f.ok({ version: "40" });
    const { rows } = await w.collect(async () => {
      await w.setStructure(1, S);
      await w.setStructure(1, S);
      await w.updateControl({ id: 31, description: null });
    });
    expect(rows).toEqual([{ kind: "course", id: 1, version: "7" }, { kind: "control", id: 31, version: "40" }]);
  });

  it("guarded: an undo of a course changed elsewhere since is skipped before anything is written", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("course", 1, "6");
    w.versions.seed("course", 1, "7"); // B reordered
    await expect(w.guarded([{ kind: "course", id: 1, version: "6" }], () => w.setStructure(1, S))).rejects.toBeInstanceOf(UndoSkipped);
    expect(f.calls).toEqual([]);
  });

  it("guarded: sent on the entry's own chain, a refusal is UndoSkipped (never a rebase), the rows renewed on success", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("course", 1, "6");
    f.ok({ version: "9" });
    expect(await w.guarded([{ kind: "course", id: 1, version: "6" }], () => w.setStructure(1, S))).toEqual([{ kind: "course", id: 1, version: "9" }]);
    expect(f.calls[0].input.baseVersion).toBe("6");
    // A change the poll has not seen yet: the server refuses the token.
    f.fail(courseConflict("12"));
    await expect(w.guarded([{ kind: "course", id: 1, version: "9" }], () => w.setStructure(1, S))).rejects.toBeInstanceOf(UndoSkipped);
    expect(f.calls).toHaveLength(2);
  });

  it("guarded: edit A, edit B, undo B, undo A all go through on the own chain (a label-offset write between them too)", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("course", 1, "5");
    f.ok({ version: "6" });
    const a = await w.collect(() => w.setStructure(1, S));
    f.ok({ version: "7" });
    await w.setLabelOffset(1, 31, null);
    f.ok({ version: "8" });
    const b = await w.collect(() => w.setStructure(1, S));
    f.ok({ version: "9" });
    await w.guarded(b.rows, () => w.setStructure(1, S));
    f.ok({ version: "10" });
    await w.guarded(a.rows, () => w.setStructure(1, S));
    // The label offset sends no token (it links from the book's 6).
    expect(f.calls.map((c) => c.input.baseVersion)).toEqual(["5", undefined, "7", "8", "9"]);
  });

  it("guarded: a control whose description only was changed elsewhere still has its move undone, keeping their description", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("control", 31, "20");
    f.fail(conflictError({ kind: "control", id: 31, version: "21", differing: ["description"] }));
    f.ok({ version: "22" });
    await w.guarded([{ kind: "control", id: 31, version: "20" }], () => w.updateControl({ id: 31, xpos: 1, ypos: 2, description: null }));
    expect(f.calls[1].input).toEqual({ id: 31, xpos: 1, ypos: 2, baseVersion: "21" });
  });

  it("guarded: two move undos across a description change elsewhere both go through; a description undo across it is skipped", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    // Two own moves: 10 → 11 → 12. Then Anna edits the description: 13.
    w.versions.seed("control", 31, "10");
    f.ok({ version: "11" });
    await w.updateControl({ id: 31, xpos: 5, ypos: 5 }, { x: 0, y: 0 });
    f.ok({ version: "12" });
    await w.updateControl({ id: 31, xpos: 9, ypos: 9 }, { x: 5, y: 5 });
    w.versions.seed("control", 31, "13");
    // Undo 1 (entry token 12): refused on 12, the field rule passes on 13 → 14.
    f.fail(conflictError({ kind: "control", id: 31, version: "13", differing: ["description"] }));
    f.ok({ version: "14" });
    await w.guarded([{ kind: "control", id: 31, version: "12" }], () => w.updateControl({ id: 31, xpos: 5, ypos: 5 }, { x: 9, y: 9 }));
    // Undo 2 (entry token 11): its own chain crosses the pass, so it goes out on 14 and is accepted.
    f.ok({ version: "15" });
    await w.guarded([{ kind: "control", id: 31, version: "11" }], () => w.updateControl({ id: 31, xpos: 0, ypos: 0, description: null }, { x: 5, y: 5 }));
    const last = f.calls[f.calls.length - 1].input;
    expect(last).toEqual({ id: 31, xpos: 0, ypos: 0, baseVersion: "14" });
    // An undo about the description that crosses the same pass is skipped without a write.
    const before = f.calls.length;
    await expect(w.guarded([{ kind: "control", id: 31, version: "11" }], () => w.updateControl({ id: 31, description: "old" }))).rejects.toBeInstanceOf(UndoSkipped);
    expect(f.calls.length).toBe(before);
  });

  it("guarded: undo, redo, undo of a move across a description change elsewhere never writes the description", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("control", 31, "1");
    f.ok({ version: "2" });
    await w.updateControl({ id: 31, xpos: 5, ypos: 5 }, { x: 0, y: 0 });
    w.versions.seed("control", 31, "3"); // Anna's description
    f.fail(conflictError({ kind: "control", id: 31, version: "3", differing: ["description"] }));
    f.ok({ version: "4" });
    let rows = await w.guarded([{ kind: "control", id: 31, version: "2" }], () => w.updateControl({ id: 31, xpos: 0, ypos: 0, description: "orig" }, { x: 5, y: 5 }));
    f.ok({ version: "5" });
    rows = await w.guarded(rows, () => w.updateControl({ id: 31, xpos: 5, ypos: 5 }, { x: 0, y: 0 }));
    f.ok({ version: "6" });
    await w.guarded(rows, () => w.updateControl({ id: 31, xpos: 0, ypos: 0, description: "orig" }, { x: 5, y: 5 }));
    expect(f.calls[f.calls.length - 1].input).toEqual({ id: 31, xpos: 0, ypos: 0, baseVersion: "5" });
  });

  it("guarded: a description left out takes autoDescribe with it", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("control", 31, "20");
    f.fail(conflictError({ kind: "control", id: 31, version: "21", differing: ["description"] }));
    f.ok({ version: "22" });
    await w.guarded([{ kind: "control", id: 31, version: "20" }], () => w.updateControl({ id: 31, xpos: 1, ypos: 2, autoDescribe: true }, { x: 0, y: 0 }));
    expect(f.calls[1].input).toEqual({ id: 31, xpos: 1, ypos: 2, baseVersion: "21" });
  });

  it("guarded: a second conflict on the field-rule re-send is UndoSkipped, not a raw error", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("control", 31, "20");
    f.fail(conflictError({ kind: "control", id: 31, version: "21", differing: ["description"] }));
    f.fail(conflictError({ kind: "control", id: 31, version: "22", differing: ["description"] }));
    await expect(w.guarded([{ kind: "control", id: 31, version: "20" }], () => w.updateControl({ id: 31, xpos: 1, ypos: 2 }, { x: 0, y: 0 }))).rejects.toBeInstanceOf(UndoSkipped);
    expect(w.versions.get("control", 31)).toBe("22");
  });

  it("guarded: a control moved elsewhere, or changed in an unknown way, skips the move undo", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("control", 31, "20");
    f.fail(conflictError({ kind: "control", id: 31, version: "21", differing: ["xpos", "ypos"] }));
    await expect(w.guarded([{ kind: "control", id: 31, version: "20" }], () => w.updateControl({ id: 31, xpos: 1, ypos: 2 }))).rejects.toBeInstanceOf(UndoSkipped);
    f.fail(conflictError({ kind: "control", id: 31, version: "22", differing: null }));
    await expect(w.guarded([{ kind: "control", id: 31, version: "20" }], () => w.updateControl({ id: 31, xpos: 1, ypos: 2 }))).rejects.toBeInstanceOf(UndoSkipped);
  });

  it("guarded: an own radio toggle (or any field the undo does not write) between an edit and its undo does not block it", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("control", 31, "20");
    f.fail(conflictError({ kind: "control", id: 31, version: "21", differing: ["radioType"] }));
    f.ok({ version: "22" });
    await w.guarded([{ kind: "control", id: 31, version: "20" }], () => w.updateControl({ id: 31, description: null }));
    expect(f.calls[1].input).toEqual({ id: 31, description: null, baseVersion: "21" });
  });

  it("guarded: a description undo is skipped when the other side changed the description", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("control", 31, "20");
    f.fail(conflictError({ kind: "control", id: 31, version: "21", differing: ["description"] }));
    await expect(w.guarded([{ kind: "control", id: 31, version: "20" }], () => w.updateControl({ id: 31, description: null }))).rejects.toBeInstanceOf(UndoSkipped);
  });

  it("a kind change's re-mirrored courses are own tokens: a structure undo after it still goes through", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("course", 1, "5");
    f.ok({ version: "6" });
    const edit = await w.collect(() => w.setStructure(1, S));
    f.ok({ version: "40", courses: [{ id: 1, version: "7" }] });
    await w.updateControl({ id: 31, kind: "start" } as never);
    expect(w.stillMine("course", 1, edit.rows[0]!.version)).toBe(true);
  });

  it("adoptOwn links answered sheet tokens from the book's", () => {
    const w = new EditorWrites(fakeClient().client);
    w.versions.seed("sheet", 3, "10");
    w.adoptOwn("sheet", [{ seq: 3, version: "11" }]);
    expect(w.stillMine("sheet", 3, "10")).toBe(true);
  });

  it("guarded: a course object's undo is never rebased (D6 per object)", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("object", 5, "30");
    f.fail(conflictError({ kind: "object", id: 5, version: "31", differing: ["props"] }));
    await expect(w.guarded([{ kind: "object", id: 5, version: "30" }], () => w.updateObject({ id: 5, geometry: { type: "Point", coordinates: [0, 0] } as never }))).rejects.toBeInstanceOf(UndoSkipped);
    expect(f.calls).toHaveLength(1);
  });

  it("writes outside an undo still rebase as before", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("control", 31, "20");
    f.fail(conflictError({ kind: "control", id: 31, version: "21", differing: ["description"] }));
    f.ok({ version: "22" });
    await w.updateControl({ id: 31, xpos: 1, ypos: 2 }, { x: 0, y: 0 });
    expect(f.calls[1].input.baseVersion).toBe("21");
  });
});

describe("EditorWrites: Layout rows and map patches one at a time (CRS-053, MAP-8)", () => {
  const deferred = <T,>() => { let resolve!: (v: T) => void; const p = new Promise<T>((r) => { resolve = r; }); return { p, resolve }; };

  it("a second sheet write waits for the first and is sent on its token", async () => {
    const f = fakeClient();
    const w = new EditorWrites(f.client);
    w.versions.seed("sheet", 3, "10");
    const first = deferred<{ version: string }>();
    const sent: (string | undefined)[] = [];
    const one = w.writeRow("sheet", 3, (base) => { sent.push(base); return first.p; });
    const two = w.writeRow("sheet", 3, async (base) => { sent.push(base); return { version: "12" }; });
    await Promise.resolve();
    expect(sent).toEqual(["10"]);
    first.resolve({ version: "11" });
    await one;
    await two;
    expect(sent).toEqual(["10", "11"]);
    expect(w.stillMine("sheet", 3, "10")).toBe(true);
  });

  it("a stale sheet token is a refresh; inside an undo, UndoSkipped", async () => {
    const w = new EditorWrites(fakeClient().client);
    w.versions.seed("sheet", 3, "10");
    const stale = () => Promise.reject(conflictError({ kind: "sheet", id: 3, version: "13", differing: null }));
    await expect(w.writeRow("sheet", 3, stale)).rejects.toBeInstanceOf(EditorConflict);
    w.versions.seed("sheet", 3, "13");
    await expect(w.guarded([{ kind: "sheet", id: 3, version: "10" }], () => w.writeRow("sheet", 3, async () => ({ version: "14" })))).rejects.toBeInstanceOf(UndoSkipped);
  });

  it("a gesture built on a refused gesture is refused too (since), one built on an own write goes on its result", async () => {
    const w = new EditorWrites(fakeClient().client);
    w.versions.seed("sheet", 3, "10");
    const sent: (string | undefined)[] = [];
    // Gesture 1 is refused: another setter wrote 13. Gesture 2 was built on gesture 1's snapshot, i.e. on 10.
    const one = w.writeRow("sheet", 3, (base) => { sent.push(base); return Promise.reject(conflictError({ kind: "sheet", id: 3, version: "13", differing: null })); }, "10");
    const two = w.writeRow("sheet", 3, (base) => {
      sent.push(base);
      return base === "13" ? Promise.resolve({ version: "14" }) : Promise.reject(conflictError({ kind: "sheet", id: 3, version: "13", differing: null }));
    }, "10");
    await expect(one).rejects.toBeInstanceOf(EditorConflict);
    await expect(two).rejects.toBeInstanceOf(EditorConflict);
    expect(sent).toEqual(["10", "10"]);
    // Built on 13 and an own write from there: the next one follows the own chain.
    await w.writeRow("sheet", 3, async () => ({ version: "14" }), "13");
    const after: (string | undefined)[] = [];
    await w.writeRow("sheet", 3, async (base) => { after.push(base); return { version: "15" }; }, "13");
    expect(after).toEqual(["14"]);
  });

  it("patch writes go one at a time, in order", async () => {
    const f = fakeClient();
    const order: string[] = [];
    const first = deferred<{ version: string; patch: null }>();
    (f.client.mapPatch!.applyChange.mutate as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { order.push("a:start"); const r = await first.p; order.push("a:end"); return r; });
    (f.client.mapPatch!.setEnabled.mutate as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { order.push("b"); return { version: "8", patch: null }; });
    const w = new EditorWrites(f.client);
    const a = w.applyPatchChange("h", { ops: {} } as never);
    const b = w.setPatchEnabled(false);
    await Promise.resolve();
    expect(order).toEqual(["a:start"]);
    first.resolve({ version: "7", patch: null });
    await a;
    await b;
    expect(order).toEqual(["a:start", "a:end", "b"]);
  });
});
