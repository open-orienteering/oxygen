/**
 * Field mode's writes through the device's outbox (row D9c; docs/course-editor.md §9 "Offline";
 * `lib/offline/control-outbox.ts`). `write` sends a move or a check-off at once when the device is online
 * and nothing waits; offline, with entries waiting (order is kept), or when the request gets no answer, it
 * queues the write — with the control's token as it is now — and the queued position or check shows at
 * once: the hook patches `course.controlCoordinates` and `control.list` in the query cache (the canvas reads
 * the cache itself) after every refetch, while the entry waits.
 *
 * The drain runs on mount, when the device comes back online, when the tab is shown again, and every
 * `RETRY_MS` while entries are pending; each settled write reloads the rows (`onSettled`).
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { activeEventNameId, trpc } from "../../lib/trpc";
import { offlineDb } from "../../lib/offline/db";
import {
  dexieControlWriteStore,
  discard as discardEntry,
  drain,
  enqueue,
  isNetworkFailure,
  outboxCounts,
  overlayChecks,
  overlayCoordinates,
  resolveConflict,
  retry as retryEntry,
  type ControlWrite,
  type FieldWrite,
  type OutboxCounts,
} from "../../lib/offline/control-outbox";
import type { EditorWrites } from "../../lib/editor/write-client";

/** How often a pending queue is retried while the browser says it is online. */
export const RETRY_MS = 10_000;

const store = dexieControlWriteStore();
const NONE: ControlWrite[] = [];

export interface FieldOutbox {
  entries: ControlWrite[];
  counts: OutboxCounts;
  /** Sends or queues one write; a conflict on a direct send throws as `EditorWrites` does. */
  write(w: FieldWrite): Promise<"sent" | "queued">;
  resolve(seq: number, keep: "mine" | "theirs"): Promise<void>;
  retryFailed(): Promise<void>;
  discardFailed(): Promise<void>;
}

/**
 * A cached query's server rows (`base`) and their answer time. The hook writes the overlaid rows under the
 * base's time, so a newer `dataUpdatedAt` is a refetch: the server's rows, the new base.
 */
interface Overlaid<T> {
  base: T | undefined;
  baseAt: number;
}

/** Puts `overlay(base)` in the cache, under the base's time, when it differs from what is there. */
function applyOverlay<T>(o: Overlaid<T>, data: T | undefined, dataAt: number, overlay: (rows: T) => T, same: (a: T, b: T) => boolean, set: (next: T, at: number) => void): void {
  if (data === undefined) return;
  if (o.base === undefined || dataAt !== o.baseAt) { o.base = data; o.baseAt = dataAt; }
  const next = overlay(o.base);
  if (!same(next, data)) set(next, o.baseAt);
}

const samePositions = (a: { mapX: number; mapY: number }[], b: { mapX: number; mapY: number }[]) =>
  a.length === b.length && a.every((r, i) => r.mapX === b[i].mapX && r.mapY === b[i].mapY);
const sameChecks = (a: { checkedAt: string | null }[], b: { checkedAt: string | null }[]) =>
  a.length === b.length && a.every((r, i) => r.checkedAt === b[i].checkedAt);

export function useFieldOutbox({ competitionId, writes, online, onSettled }: {
  competitionId: string;
  writes: EditorWrites;
  online: boolean;
  /** Reload the rows (the page's cache invalidation). */
  onSettled: () => void;
}): FieldOutbox {
  const utils = trpc.useUtils();
  const entries = useLiveQuery(
    async () => (await offlineDb.controlWrites.where("competitionId").equals(competitionId).toArray()).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)),
    [competitionId],
  ) ?? NONE;
  const counts = useMemo(() => outboxCounts(entries), [entries]);
  const settledRef = useRef(onSettled);
  useEffect(() => { settledRef.current = onSettled; }, [onSettled]);

  const coords = trpc.course.controlCoordinates.useQuery(undefined, { staleTime: Number.POSITIVE_INFINITY });
  const list = trpc.control.list.useQuery();
  const coordsOverlay = useRef<Overlaid<NonNullable<typeof coords.data>>>({ base: undefined, baseAt: 0 });
  const listOverlay = useRef<Overlaid<NonNullable<typeof list.data>>>({ base: undefined, baseAt: 0 });

  // Set when the editor closes: a drain in flight stops before its next entry (MC-17).
  const gone = useRef(false);
  useEffect(() => {
    gone.current = false;
    return () => { gone.current = true; };
  }, []);

  const drainNow = useCallback(async () => {
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    // A sent write is the server's now: into the base, so the shown value holds until the refetch answers.
    const onSent = (e: ControlWrite) => {
      const c = coordsOverlay.current, l = listOverlay.current;
      if (c.base) c.base = overlayCoordinates(c.base, [e]);
      if (l.base) l.base = overlayChecks(l.base, [e]);
    };
    // Only while this editor is open on the entries' event (MC-17): `writes` is pinned to it, and a drain stops
    // once the page has moved to another event or closed, leaving the rest for that event's next drain.
    const active = () => !gone.current && activeEventNameId() === competitionId;
    const r = await drain(store, writes, competitionId, { onSent, active });
    if (r && (r.sent || r.conflicts || r.failed)) settledRef.current();
  }, [writes, competitionId]);

  const write = useCallback(async (w: FieldWrite): Promise<"sent" | "queued"> => {
    const queue = async () => {
      const baseVersion = w.kind === "move" ? w.baseVersion ?? writes.versions.get("control", w.input.id) : undefined;
      await enqueue(store, competitionId, w.kind === "move" ? { ...w, baseVersion } : w);
      void drainNow();
      return "queued" as const;
    };
    const waiting = (await store.atomic((tx) => tx.list(competitionId))).length > 0;
    if (!navigator.onLine || waiting) return queue();
    try {
      if (w.kind === "move") await writes.updateControl(w.input, w.from, w.baseVersion ? { baseVersion: w.baseVersion } : undefined);
      else await writes.checkControl(w.controlId, w.checked);
      return "sent";
    } catch (e) {
      if (isNetworkFailure(e)) return queue();
      throw e;
    }
  }, [writes, competitionId, drainNow]);

  // Drain on mount, on reconnect, while pending (every RETRY_MS), and when the tab is shown again.
  const hasPending = counts.pending > 0;
  useEffect(() => {
    if (!online || !hasPending) return;
    void drainNow();
    const timer = setInterval(() => { void drainNow(); }, RETRY_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void drainNow(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [online, hasPending, drainNow]);

  // The own-writes overlay: the queued positions and check-offs over whatever the server last answered. The
  // server's rows are kept (`base`): an entry that drops out offline (an undo) shows the server's value again
  // without a refetch.
  useEffect(() => {
    applyOverlay(coordsOverlay.current, coords.data, coords.dataUpdatedAt, (rows) => overlayCoordinates(rows, entries), samePositions,
      (next, at) => utils.course.controlCoordinates.setData(undefined, next, { updatedAt: at }));
    applyOverlay(listOverlay.current, list.data, list.dataUpdatedAt, (rows) => overlayChecks(rows, entries), sameChecks,
      (next, at) => utils.control.list.setData(undefined, next, { updatedAt: at }));
  }, [entries, coords.data, coords.dataUpdatedAt, list.data, list.dataUpdatedAt, utils]);

  const after = useCallback(async (op: Promise<void>) => {
    await op;
    settledRef.current();
    void drainNow();
  }, [drainNow]);

  const resolve = useCallback((seq: number, keep: "mine" | "theirs") => after(resolveConflict(store, seq, keep)), [after]);
  const retryFailed = useCallback(
    () => after(Promise.all(entries.filter((e) => e.status === "failed").map((e) => retryEntry(store, e.seq!))).then(() => undefined)),
    [after, entries],
  );
  const discardFailed = useCallback(
    () => after(Promise.all(entries.filter((e) => e.status === "failed").map((e) => discardEntry(store, e.seq!))).then(() => undefined)),
    [after, entries],
  );

  return useMemo(() => ({ entries, counts, write, resolve, retryFailed, discardFailed }), [entries, counts, write, resolve, retryFailed, discardFailed]);
}
