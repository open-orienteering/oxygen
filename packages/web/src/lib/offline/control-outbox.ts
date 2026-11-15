/**
 * Field mode's outbox (row D9c; docs/course-editor.md §9 "Offline",
 * docs/offline-architecture.md "Station resilience"): the course editor's
 * moves (`control.update { xpos, ypos }` — a long-press drag, a nudge, the
 * pad's numeric fields, their undo / redo) and check-offs
 * (`control.check`) wait here while the device has no connection, and are
 * replayed in order on reconnect through `EditorWrites` under G1's rules
 * (§3 "Conflicts").
 *
 * A sibling of the timing journal's `events` outbox (`db.ts`, drained into
 * `events.push`), not a reuse: that path carries full-row last-writer-wins
 * upserts and skips the version token, so neither the field-move rebase nor
 * "Moved by X" could happen through it (decision log, D9c).
 *
 * - **One move and one check entry per control.** A second move of the same
 *   control keeps the entry's first `from` and token and takes the newest
 *   position; a move back to where the entry started, or a check toggled
 *   back, drops it. An entry in flight is never dropped: the newer value
 *   replaces it and goes out after it (`rev`).
 * - **Each move keeps the token it was queued with**: after reconnect the
 *   refetch seeds the `VersionBook` with the server's newer token, which
 *   would hide a move made elsewhere meanwhile. Only the outbox's own
 *   successful move advances a later write's token.
 * - **Drain**: in `seq` order; success removes the entry; `moved` keeps it
 *   as a `conflict` for the setter (Keep mine / Keep theirs); no server
 *   answer stops the drain with the rest pending; any other answer marks
 *   it `failed` (Retry / Discard) — nothing is dropped silently.
 *
 * Pure parts (`enqueueInto`, the overlays, `outboxCounts`) are unit-tested;
 * the store is Dexie in the browser (`dexieControlWriteStore`, table
 * `controlWrites` of `oxygen-offline`) and memory in tests.
 */

import { TRPCClientError } from "@trpc/client";
import { offlineDb } from "./db";
import { EditorConflict, type EditorWrites } from "../editor/write-client";

type Pt = { x: number; y: number };

/** A queued move's `control.update` input (no token: the entry carries it). */
export interface MoveInput {
  id: number;
  xpos: number;
  ypos: number;
  autoDescribe?: boolean;
  /** An undo's restored description (§3: undo puts the description back). */
  description?: unknown;
}

/** What the page asks to write. */
export type FieldWrite =
  /** `from` set: a move under the field-move rule; unset (an undo restoring a description): a plain control write. */
  | { kind: "move"; input: MoveInput; from?: Pt; baseVersion?: string }
  | { kind: "check"; controlId: number; checked: boolean };

export type ControlWriteStatus = "pending" | "conflict" | "failed";

interface EntryBase {
  /** Dexie's auto-increment key: the replay order. */
  seq?: number;
  competitionId: string;
  controlId: number;
  status: ControlWriteStatus;
  /** Bumped by each write merged into the entry; the drain settles only the revision it sent. */
  rev: number;
  /** True while the drain has it on the wire. */
  sending?: boolean;
  /** A `failed` entry's reason (the server's message, or `CHANGED_ELSEWHERE`). */
  error?: string;
  attempts: number;
  createdAt: number;
}

export interface ControlMoveEntry extends EntryBase {
  kind: "move";
  input: MoveInput;
  from?: Pt;
  baseVersion?: string;
  /** A `conflict`: where the other side put it, and the server's token. */
  theirs?: Pt | null;
  serverVersion?: string;
}

export interface ControlCheckEntry extends EntryBase {
  kind: "check";
  checked: boolean;
}

export type ControlWrite = ControlMoveEntry | ControlCheckEntry;

/** A `failed` entry's reason when the write could not be merged (§3: "Changed elsewhere"). */
export const CHANGED_ELSEWHERE = "changed-elsewhere";

const EPS = 1e-6;
const samePt = (a: Pt | undefined | null, b: Pt | undefined | null) => !!a && !!b && Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
const ptOf = (input: MoveInput): Pt => ({ x: input.xpos, y: input.ypos });

/** What `enqueueInto` asks the store to do: add a new entry, replace one, delete one, or nothing. */
export interface EnqueueOp {
  add?: ControlWrite;
  put?: ControlWrite;
  delete?: number;
}

/** Merges a write into the event's entries (the coalescing rules above). Pure. */
export function enqueueInto(entries: readonly ControlWrite[], w: FieldWrite, competitionId: string, now: number): EnqueueOp {
  const controlId = w.kind === "move" ? w.input.id : w.controlId;
  const existing = entries.find((e) => e.competitionId === competitionId && e.kind === w.kind && e.controlId === controlId);
  const fresh = { competitionId, controlId, status: "pending" as const, rev: 0, attempts: 0, createdAt: now };
  if (w.kind === "move") {
    if (!existing) return { add: { ...fresh, kind: "move", input: w.input, from: w.from, baseVersion: w.baseVersion } };
    const e = existing as ControlMoveEntry;
    const inConflict = e.status === "conflict";
    // Moved on from a conflict: the setter keeps theirs as the start, on the server's token (Keep mine, moved on).
    const from = inConflict ? e.theirs ?? e.from : e.from;
    const baseVersion = inConflict ? e.serverVersion ?? e.baseVersion : e.baseVersion;
    if (!e.sending && samePt(ptOf(w.input), from)) return { delete: e.seq! };
    return { put: { ...e, input: w.input, from, baseVersion, status: "pending", theirs: undefined, serverVersion: undefined, error: undefined, rev: e.rev + 1 } };
  }
  if (!existing) return { add: { ...fresh, kind: "check", checked: w.checked } };
  const e = existing as ControlCheckEntry;
  if (e.checked === w.checked) return {};
  if (!e.sending) return { delete: e.seq! };
  return { put: { ...e, checked: w.checked, status: "pending", error: undefined, rev: e.rev + 1 } };
}

/** The coordinates rows with the queued moves applied; the same array when nothing changes. */
export function overlayCoordinates<T extends { id: number; mapX: number; mapY: number }>(rows: T[], entries: readonly ControlWrite[]): T[] {
  const moves = new Map<number, MoveInput>();
  for (const e of entries) if (e.kind === "move") moves.set(e.controlId, e.input);
  if (moves.size === 0) return rows;
  let changed = false;
  const out = rows.map((r) => {
    const m = moves.get(r.id);
    if (!m || (Math.abs(r.mapX - m.xpos) < EPS && Math.abs(r.mapY - m.ypos) < EPS)) return r;
    changed = true;
    return { ...r, mapX: m.xpos, mapY: m.ypos };
  });
  return changed ? out : rows;
}

/** The control-list rows with the queued check-offs applied (a stored time kept); the same array when nothing changes. */
export function overlayChecks<T extends { id: number; checkedAt: string | null }>(rows: T[], entries: readonly ControlWrite[]): T[] {
  const checks = new Map<number, ControlCheckEntry>();
  for (const e of entries) if (e.kind === "check") checks.set(e.controlId, e);
  if (checks.size === 0) return rows;
  let changed = false;
  const out = rows.map((r) => {
    const c = checks.get(r.id);
    if (!c || !!r.checkedAt === c.checked) return r;
    changed = true;
    return { ...r, checkedAt: c.checked ? new Date(c.createdAt).toISOString() : null };
  });
  return changed ? out : rows;
}

export interface OutboxCounts {
  total: number;
  pending: number;
  conflict: number;
  failed: number;
}

export function outboxCounts(entries: readonly ControlWrite[]): OutboxCounts {
  const c: OutboxCounts = { total: entries.length, pending: 0, conflict: 0, failed: 0 };
  for (const e of entries) c[e.status]++;
  return c;
}

/** No answer from a server: offline, or a request that failed without a tRPC error body. A server's answer is never re-queued. */
export function isNetworkFailure(e: unknown): boolean {
  if (e instanceof EditorConflict) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  return e instanceof TRPCClientError && !e.data;
}

// ─── Store ──────────────────────────────────────────────────

export interface ControlWriteTx {
  /** The event's entries in `seq` order. */
  list(competitionId: string): Promise<ControlWrite[]>;
  get(seq: number): Promise<ControlWrite | undefined>;
  add(e: ControlWrite): Promise<number>;
  put(e: ControlWrite): Promise<void>;
  delete(seq: number): Promise<void>;
}

/** Each `atomic` runs alone: a write merged while the drain settles an entry cannot interleave with it. */
export interface ControlWriteStore {
  atomic<T>(fn: (tx: ControlWriteTx) => Promise<T>): Promise<T>;
}

const bySeq = (a: ControlWrite, b: ControlWrite) => (a.seq ?? 0) - (b.seq ?? 0);

/** The browser's store: `controlWrites` in `oxygen-offline` (Dexie v4), one rw transaction per `atomic`. */
export function dexieControlWriteStore(): ControlWriteStore {
  const table = offlineDb.controlWrites;
  const tx: ControlWriteTx = {
    list: async (competitionId) => (await table.where("competitionId").equals(competitionId).toArray()).sort(bySeq),
    get: async (seq) => table.get(seq),
    add: async (e) => table.add(e),
    put: async (e) => { await table.put(e); },
    delete: async (seq) => { await table.delete(seq); },
  };
  return { atomic: (fn) => offlineDb.transaction("rw", table, () => fn(tx)) };
}

/** For tests: the same contract in memory, `atomic` calls chained. */
export function memoryControlWriteStore(): ControlWriteStore {
  let rows: ControlWrite[] = [];
  let nextSeq = 1;
  let chain: Promise<unknown> = Promise.resolve();
  const tx: ControlWriteTx = {
    list: async (competitionId) => rows.filter((r) => r.competitionId === competitionId).map((r) => structuredClone(r)).sort(bySeq),
    get: async (seq) => { const r = rows.find((x) => x.seq === seq); return r ? structuredClone(r) : undefined; },
    add: async (e) => { const seq = nextSeq++; rows.push(structuredClone({ ...e, seq })); return seq; },
    put: async (e) => { rows = rows.map((r) => (r.seq === e.seq ? structuredClone(e) : r)); },
    delete: async (seq) => { rows = rows.filter((r) => r.seq !== seq); },
  };
  return {
    atomic: <T,>(fn: (t: ControlWriteTx) => Promise<T>) => {
      const run = chain.then(() => fn(tx));
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

async function applyOp(tx: ControlWriteTx, op: EnqueueOp): Promise<void> {
  if (op.add) await tx.add(op.add);
  if (op.put) await tx.put(op.put);
  if (op.delete !== undefined) await tx.delete(op.delete);
}

/** Queues a write (merging it into the control's entry). */
export function enqueue(store: ControlWriteStore, competitionId: string, w: FieldWrite, now = Date.now()): Promise<void> {
  return store.atomic(async (tx) => applyOp(tx, enqueueInto(await tx.list(competitionId), w, competitionId, now)));
}

async function update(store: ControlWriteStore, seq: number, fn: (e: ControlWrite) => ControlWrite | null): Promise<void> {
  await store.atomic(async (tx) => {
    const e = await tx.get(seq);
    if (!e) return;
    const next = fn(e);
    if (next) await tx.put(next);
    else await tx.delete(seq);
  });
}

/** Keep mine: pending again from their position on the server's token. Keep theirs: dropped. */
export function resolveConflict(store: ControlWriteStore, seq: number, keep: "mine" | "theirs"): Promise<void> {
  return update(store, seq, (e) => {
    if (keep === "theirs" || e.kind !== "move") return null;
    return { ...e, status: "pending", from: e.theirs ?? e.from, baseVersion: e.serverVersion ?? e.baseVersion, theirs: undefined, serverVersion: undefined, rev: e.rev + 1 };
  });
}

/** Retry a failed entry: pending again; a move on the book's newest token (the setter insists). */
export function retry(store: ControlWriteStore, seq: number): Promise<void> {
  return update(store, seq, (e) => (e.kind === "move"
    ? { ...e, status: "pending", error: undefined, baseVersion: undefined }
    : { ...e, status: "pending", error: undefined }));
}

/** Discard an entry. */
export function discard(store: ControlWriteStore, seq: number): Promise<void> {
  return update(store, seq, () => null);
}

// ─── Drain ──────────────────────────────────────────────────

/** The two `EditorWrites` calls the drain makes. */
export type DrainWrites = Pick<EditorWrites, "updateControl" | "checkControl">;

export interface DrainResult {
  sent: number;
  conflicts: number;
  failed: number;
  /** True when a write got no answer: the rest wait for the next drain. */
  stopped: boolean;
}

const draining = new Set<string>();

/** Runs `fn` unless another drain of the event runs, in this tab (the set) or another (Web Locks): null then. */
async function exclusive<T>(competitionId: string, fn: () => Promise<T>): Promise<T | null> {
  if (draining.has(competitionId)) return null;
  draining.add(competitionId);
  try {
    const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
    if (!locks?.request) return await fn();
    // Two tabs replaying one move would answer each other with a false "moved".
    return await locks.request(`oxygen-control-outbox:${competitionId}`, { ifAvailable: true }, async (lock) => (lock ? fn() : null));
  } finally {
    draining.delete(competitionId);
  }
}

/**
 * Replays the event's pending entries in order (see the module notes). Returns null when another drain of the
 * event is running.
 */
export function drain(
  store: ControlWriteStore,
  writes: DrainWrites,
  competitionId: string,
  opts: { /** Called with each entry the server took, as sent. */ onSent?: (e: ControlWrite) => void } = {},
): Promise<DrainResult | null> {
  return exclusive(competitionId, async () => {
    const result: DrainResult = { sent: 0, conflicts: 0, failed: 0, stopped: false };
    /** The next entry to send has a key at or after this one. */
    let cursor = 0;
    for (;;) {
      // Pick the next pending entry and mark it in flight, in one step.
      const sent = await store.atomic(async (tx) => {
        const next = (await tx.list(competitionId)).find((e) => e.status === "pending" && (e.seq ?? 0) >= cursor);
        if (!next) return null;
        const marked = { ...next, sending: true } as ControlWrite;
        await tx.put(marked);
        return marked;
      });
      if (!sent) break;
      let outcome: { ok: { version: string } } | { conflict: { theirs: Pt | null; version: string } } | { failed: string } | "network";
      try {
        const res = sent.kind === "move"
          ? await writes.updateControl(sent.input, sent.from, { baseVersion: sent.baseVersion })
          : await writes.checkControl(sent.controlId, sent.checked);
        outcome = { ok: res };
      } catch (e) {
        if (e instanceof EditorConflict && e.decision.kind === "moved") {
          // Their position is ours: this write landed before its answer was lost.
          outcome = sent.kind === "move" && samePt(e.decision.theirs, ptOf(sent.input))
            ? { ok: { version: e.decision.version } }
            : { conflict: { theirs: e.decision.theirs, version: e.decision.version } };
        } else if (e instanceof EditorConflict) outcome = { failed: CHANGED_ELSEWHERE };
        else if (isNetworkFailure(e)) outcome = "network";
        else outcome = { failed: e instanceof Error ? e.message : String(e) };
      }
      /** True when the entry was merged into while in flight and goes out again next. */
      const again = await store.atomic(async (tx) => {
        const cur = await tx.get(sent.seq!);
        if (!cur) return false;
        if (outcome === "network") { await tx.put({ ...cur, sending: false }); return false; }
        if ("ok" in outcome) {
          if (cur.rev === sent.rev) { await tx.delete(cur.seq!); return false; }
          // Merged into while in flight: the newer value goes next, a move from where this one put it, on its token.
          if (cur.kind === "move" && sent.kind === "move") {
            const from = ptOf(sent.input);
            if (samePt(ptOf(cur.input), from)) { await tx.delete(cur.seq!); return false; }
            await tx.put({ ...cur, sending: false, from, baseVersion: outcome.ok.version });
          } else await tx.put({ ...cur, sending: false });
          return true;
        }
        if ("conflict" in outcome) {
          await tx.put({ ...(cur as ControlMoveEntry), status: "conflict", sending: false, theirs: outcome.conflict.theirs, serverVersion: outcome.conflict.version });
          return false;
        }
        await tx.put({ ...cur, status: "failed", sending: false, error: outcome.failed, attempts: cur.attempts + 1 });
        return false;
      });
      cursor = again ? sent.seq! : sent.seq! + 1;
      if (outcome === "network") { result.stopped = true; break; }
      if ("ok" in outcome) { result.sent++; opts.onSent?.(sent); }
      else if ("conflict" in outcome) result.conflicts++;
      else result.failed++;
    }
    return result;
  });
}
