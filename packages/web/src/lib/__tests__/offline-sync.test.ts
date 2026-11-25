import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEventDrainer,
  getDrainBlockedReason,
  type EventStore,
  type PushFn,
  type PushResult,
} from "../offline/sync";
import type { OxygenEvent } from "../offline/db";

function memoryStore(rows: OxygenEvent[]): EventStore & { rows: Map<string, OxygenEvent> } {
  const map = new Map(rows.map((r) => [r.id, r]));
  return {
    rows: map,
    async pending(competitionId) {
      return [...map.values()]
        .filter((e) => e.status === "pending" && (!competitionId || e.competitionId === competitionId))
        .sort((a, b) => a.timestamp - b.timestamp);
    },
    async failed(competitionId) {
      return [...map.values()].filter((e) => e.status === "failed" && e.competitionId === competitionId);
    },
    async get(id) {
      return map.get(id);
    },
    async update(id, patch) {
      const row = map.get(id);
      if (row) map.set(id, { ...row, ...patch });
    },
    async bulkDelete(ids) {
      ids.forEach((id) => map.delete(id));
    },
    async syncedOlderThan(cutoff) {
      return [...map.values()].filter((e) => e.status === "synced" && e.timestamp < cutoff);
    },
  };
}

let seq = 0;
function entry(competitionId: string, over: Partial<OxygenEvent> = {}): OxygenEvent {
  seq++;
  return {
    id: `e${seq}`,
    type: "runner.registered",
    competitionId,
    stationId: "s",
    timestamp: 1000 + seq,
    payload: {} as OxygenEvent["payload"],
    status: "pending",
    attempts: 0,
    ...over,
  };
}

const acceptAll: PushFn = async ({ events }) => ({ synced: events.map((e) => e.id), failed: [] });

function trpcError(code: string) {
  return Object.assign(new Error(code), { data: { code } });
}

beforeEach(() => {
  seq = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("event drain", () => {
  it("1. sends each competition's entries under its own competition, whatever the URL says", async () => {
    const store = memoryStore([entry("a"), entry("b"), entry("a")]);
    const sent: Array<[string, string[]]> = [];
    const drainer = createEventDrainer({
      store,
      pushFor: (c) => async ({ events }) => {
        sent.push([c, events.map((e) => e.competitionId)]);
        return acceptAll({ events });
      },
    });
    expect(await drainer.drain()).toBe(3);
    expect(sent).toEqual([
      ["a", ["a", "a"]],
      ["b", ["b"]],
    ]);
  });

  it("2. keeps the original competition when the location changes between batches", async () => {
    const store = memoryStore(Array.from({ length: 120 }, () => entry("a")));
    const used: string[] = [];
    const drainer = createEventDrainer({
      store,
      pushFor: (c) => async (input) => {
        used.push(c);
        return acceptAll(input);
      },
    });
    expect(await drainer.drain("a")).toBe(120);
    expect(used).toEqual(["a", "a", "a"]);
  });

  it("3. drains B while A's drain is still running", async () => {
    const store = memoryStore([entry("a"), entry("b")]);
    let releaseA!: () => void;
    const gate = new Promise<void>((r) => (releaseA = r));
    const drainer = createEventDrainer({
      store,
      pushFor: (c) => async (input) => {
        if (c === "a") await gate;
        return acceptAll(input);
      },
    });
    const a = drainer.drain("a");
    expect(await drainer.drain("b")).toBe(1);
    // A is locked: a second drain of A does nothing.
    expect(await drainer.drain("a")).toBe(0);
    releaseA();
    expect(await a).toBe(1);
  });

  it("4. marks synced and failed, bumps attempts, stores the code and capability", async () => {
    const ok = entry("a");
    const bad = entry("a", { attempts: 1 });
    const store = memoryStore([ok, bad]);
    const push: PushFn = async () => ({
      synced: [ok.id],
      failed: [{ id: bad.id, error: "FORBIDDEN", capability: "race.operate" }],
    });
    const drainer = createEventDrainer({ store, pushFor: () => push });
    expect(await drainer.drain()).toBe(1);
    expect(store.rows.get(ok.id)?.status).toBe("synced");
    expect(store.rows.get(bad.id)).toMatchObject({
      status: "failed",
      error: "FORBIDDEN",
      capability: "race.operate",
      attempts: 2,
    });
  });

  it("5. a network error leaves everything pending without a blocked reason; UNAUTHORIZED blocks as auth", async () => {
    const store = memoryStore([entry("a"), entry("a")]);
    const net = createEventDrainer({
      store,
      pushFor: () => async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(await net.drain()).toBe(0);
    expect(getDrainBlockedReason("a")).toBeNull();
    expect((await store.pending()).length).toBe(2);

    const auth = createEventDrainer({
      store,
      pushFor: () => async () => {
        throw trpcError("UNAUTHORIZED");
      },
    });
    await auth.drain();
    expect(getDrainBlockedReason("a")).toBe("auth");
    expect((await store.pending()).length).toBe(2);
  });

  it("6a. BAD_REQUEST with a passing probe: only the bad entry fails, the other 49 sync", async () => {
    const rows = Array.from({ length: 50 }, () => entry("a"));
    const store = memoryStore(rows);
    const badId = rows[7].id;
    const push: PushFn = async ({ events }) => {
      if (events.length > 1) throw trpcError("BAD_REQUEST");
      if (events[0]?.id === badId) throw trpcError("BAD_REQUEST");
      return acceptAll({ events });
    };
    const drainer = createEventDrainer({ store, pushFor: () => push });
    expect(await drainer.drain()).toBe(49);
    expect(store.rows.get(badId)).toMatchObject({ status: "failed", error: "INVALID_PAYLOAD", attempts: 1 });
    expect([...store.rows.values()].filter((e) => e.status === "synced")).toHaveLength(49);
  });

  it("6b. BAD_REQUEST with a failing probe: all stay pending, blocked as event", async () => {
    const store = memoryStore([entry("a"), entry("a")]);
    const drainer = createEventDrainer({
      store,
      pushFor: () => async () => {
        throw trpcError("BAD_REQUEST");
      },
    });
    expect(await drainer.drain()).toBe(0);
    expect(getDrainBlockedReason("a")).toBe("event");
    expect((await store.pending()).length).toBe(2);
  });

  it("7. a server error leaves everything pending, blocked as server", async () => {
    const store = memoryStore([entry("a")]);
    const drainer = createEventDrainer({
      store,
      pushFor: () => async () => {
        throw trpcError("INTERNAL_SERVER_ERROR");
      },
    });
    await drainer.drain();
    expect(getDrainBlockedReason("a")).toBe("server");
    expect((await store.pending()).length).toBe(1);
  });

  it("8. a partial answer is followed by another round for the rest, and the loop ends", async () => {
    const store = memoryStore(Array.from({ length: 5 }, () => entry("a")));
    const calls: number[] = [];
    const push: PushFn = async ({ events }) => {
      calls.push(events.length);
      // The server stops after two entries.
      return { synced: events.slice(0, 2).map((e) => e.id), failed: [] } satisfies PushResult;
    };
    const drainer = createEventDrainer({ store, pushFor: () => push });
    expect(await drainer.drain()).toBe(5);
    expect(calls).toEqual([5, 3, 1]);

    // An answer that settles nothing does not loop forever.
    const stuck = memoryStore([entry("a")]);
    const d2 = createEventDrainer({
      store: stuck,
      pushFor: () => async () => ({ synced: [], failed: [] }),
    });
    expect(await d2.drain()).toBe(0);
  });

  it("9. cleanup removes old synced rows and keeps pending and failed ones", async () => {
    const now = 10 * 24 * 60 * 60 * 1000;
    const store = memoryStore([
      entry("a", { status: "synced", timestamp: 1 }),
      entry("a", { status: "synced", timestamp: now }),
      entry("a", { status: "pending", timestamp: 1 }),
      entry("a", { status: "failed", timestamp: 1 }),
    ]);
    const drainer = createEventDrainer({ store, pushFor: () => acceptAll, now: () => now });
    expect(await drainer.cleanupSynced()).toBe(1);
    expect(store.rows.size).toBe(3);
  });

  it("10. an APPLY_FAILED answer ends that competition's pass: later entries stay pending, other competitions still drain", async () => {
    const reg = entry("a");
    const finish = entry("a", { type: "finish.recorded" });
    const other = entry("b");
    const store = memoryStore([reg, finish, other]);
    const sent: string[][] = [];
    const push: PushFn = async ({ events }) => {
      sent.push(events.map((e) => e.id));
      // The server stops its batch at the failed registration.
      if (events[0].id === reg.id) return { synced: [], failed: [{ id: reg.id, error: "APPLY_FAILED" }] };
      return acceptAll({ events });
    };
    const drainer = createEventDrainer({ store, pushFor: () => push });
    expect(await drainer.drain()).toBe(1);
    expect(store.rows.get(reg.id)?.status).toBe("failed");
    expect(store.rows.get(finish.id)?.status).toBe("pending");
    expect(store.rows.get(other.id)?.status).toBe("synced");

    // A later drain does not push the finish ahead of the failed registration.
    sent.length = 0;
    expect(await drainer.drain()).toBe(0);
    expect(sent).toEqual([]);
  });

  it("11. retrying or discarding the failed entry releases the entries behind it", async () => {
    const mk = () => {
      const reg = entry("a", { status: "failed", error: "APPLY_FAILED" });
      const finish = entry("a", { type: "finish.recorded" });
      return { reg, finish, store: memoryStore([reg, finish]) };
    };
    const sent: string[][] = [];
    const push: PushFn = async (input) => {
      sent.push(input.events.map((e) => e.id));
      return acceptAll(input);
    };

    const discard = mk();
    const d1 = createEventDrainer({ store: discard.store, pushFor: () => push });
    expect(await d1.drain()).toBe(0);
    await discard.store.bulkDelete([discard.reg.id]);
    expect(await d1.drain()).toBe(1);

    const retry = mk();
    sent.length = 0;
    const d2 = createEventDrainer({ store: retry.store, pushFor: () => push });
    await retry.store.update(retry.reg.id, { status: "pending", error: undefined });
    expect(await d2.drain()).toBe(2);
    expect(sent).toEqual([[retry.reg.id, retry.finish.id]]);
  });

  it("12. a refusal that does not stop the server (FORBIDDEN) holds nothing back", async () => {
    const denied = entry("a", { status: "failed", error: "FORBIDDEN" });
    const next = entry("a");
    const store = memoryStore([denied, next]);
    const drainer = createEventDrainer({ store, pushFor: () => acceptAll });
    expect(await drainer.drain()).toBe(1);
  });

  it("13. the blocked reason is kept per competition", async () => {
    const store = memoryStore([entry("a"), entry("b")]);
    const drainer = createEventDrainer({
      store,
      pushFor: (c) => async (input) => {
        if (c === "a") throw trpcError("UNAUTHORIZED");
        return acceptAll(input);
      },
    });
    await drainer.drain();
    expect(getDrainBlockedReason("a")).toBe("auth");
    expect(getDrainBlockedReason("b")).toBeNull();
  });
});
