/**
 * Automatic leg routes (docs/course-elevation.md §7.5): every directed
 * control pair an ordered course runs gets one automatic route — the
 * shortest way that crosses nothing uncrossable — so the stored climb
 * follows it without a click per leg. The search runs in a worker
 * thread after the edit has committed, never in its request; until it
 * lands the climb is read as before.
 *
 * An automatic row is `leg_routes` with `auto_basis` set: a digest of
 * what it was searched on. A pair whose digest is current is not
 * searched again. The row is created chosen unless a person chose
 * another route for the pair; a refresh never changes `chosen`, so a
 * person's choice (another route, or the drawn line) stays.
 */

import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { course, mapDocument } from "@oxygen/shared";
import { Prisma, type PrismaClient } from "./generated/prisma/client.js";
import { clearComputedClimbs, editorCourseLayer, loadCourseSequences } from "./course-geometry.js";
import { refreshComputedClimbs } from "./course-climb.js";
import { coursesByPair } from "./leg-routes.js";
import { storedObjectOf } from "./course-objects.js";
import { eventPin } from "./map-store/event-document.js";
import { eventPatchOnPin } from "./map-store/patches.js";
import { mayRunBackgroundJob } from "./background-lease.js";
import { workerBootstrap } from "./worker-bootstrap.js";

/** Bumped when the search changes what it finds: every automatic route is searched again. */
export const AUTO_ROUTE_VERSION = 1;
export const AUTO_ROUTE_MODEL = "shortest";
/** The pairs searched by one worker; its routes are written before the next is started. */
export const AUTO_ROUTE_CHUNK = 20;
/** One job may take this long before it is given up (a long leg is a few seconds). */
export const AUTO_ROUTE_JOB_TIMEOUT_MS = 60_000;

type Pt = course.RoutePoint;

/** An uncrossable object of the course layer, as the search takes it. */
export interface AutoRouteObstacle { kind: "area" | "line"; coords: number[] }

export interface AutoRouteJob {
  from: Pt;
  to: Pt;
  via?: Pt;
  obstacles: AutoRouteObstacle[];
}

/** What a worker prepares once: the encoded map document and the event's patch on it. */
export interface AutoRouteInit {
  bytes: Uint8Array;
  patch: mapDocument.MapPatch | null;
  groundMPerMm: number;
}

/** A chunk of jobs on one document (the seam of `RefreshAutoRoutesOptions.search`). */
export interface AutoRouteWorkerData extends AutoRouteInit {
  jobs: AutoRouteJob[];
}

/** One job's outcome: the route's interior vertices (none: the line is the route; null: no way at all), or its failure. */
export type AutoRouteResult = { ok: true; points: Pt[] | null } | { ok: false; error: string };

/** Host → worker. */
export type AutoRouteWorkerRequest = { type: "search"; id: number; job: AutoRouteJob };
/** Worker → host. */
export type AutoRouteWorkerMessage =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "route"; id: number; points: Pt[] | null }
  | { type: "failed"; id: number; message: string };

interface Pair extends AutoRouteJob {
  fromId: string;
  toId: string;
  basis: string;
  /** The courses running the pair. */
  courses: string[];
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const pt = (p: Pt) => [round(p.x), round(p.y)];

/** What a pair's automatic route rests on. */
export function autoRouteBasis(input: { documentHash: string; patchVersion: string; scale: number; from: Pt; to: Pt; via?: Pt; obstacles: readonly AutoRouteObstacle[] }): string {
  const body = JSON.stringify([
    AUTO_ROUTE_VERSION, input.documentHash, input.patchVersion, input.scale, pt(input.from), pt(input.to), input.via ? pt(input.via) : null,
    input.obstacles.map((o) => [o.kind, o.coords.map(round)]),
  ]);
  return createHash("sha256").update(body).digest("hex").slice(0, 32);
}

/** The out-of-bounds objects of the course layer (course-layer.md §9.3: `oob_area`, a 708 `oob_line`) with the courses each is drawn with (null: all). */
async function obstaclesOf(db: PrismaClient, eventId: bigint): Promise<{ obstacle: AutoRouteObstacle; courses: Set<string> | null }[]> {
  const rows = await db.courseObject.findMany({ where: { eventId, kind: { in: ["oob_area", "oob_line"] } }, orderBy: { seq: "asc" } });
  const out: { obstacle: AutoRouteObstacle; courses: Set<string> | null }[] = [];
  for (const row of rows) {
    const o = storedObjectOf(row);
    if (!o) continue;
    const coords = (o.geometry as readonly Pt[]).flatMap((v) => [v.x, v.y]);
    const line = o.kind === "oob_line";
    if (line && ((o.props as { symbol?: string }).symbol ?? "708") !== "708") continue;
    if (coords.length < (line ? 4 : 6)) continue;
    out.push({ obstacle: { kind: line ? "line" : "area", coords }, courses: "all" in o.scope ? null : new Set(o.scope.courses) });
  }
  return out;
}

/**
 * The pairs of the event's live ordered courses with what each is
 * searched on; null when the event has no map document to search.
 * A marked-route leg is its own route and gets none (§7.3).
 */
async function pairsOf(db: PrismaClient, eventId: bigint): Promise<{ pairs: Pair[]; documentHash: string; patch: mapDocument.MapPatch | null; scale: number } | null> {
  const pin = await eventPin(db, eventId);
  if (!pin?.documentHash || !pin.scale) return null;
  const courses = await db.course.findMany({ where: { eventId, removed: false, orderMode: "ordered" }, select: { id: true }, orderBy: { id: "asc" } });
  if (courses.length === 0) return null;
  const { version: patchVersion, patch } = await eventPatchOnPin(db, eventId, pin.documentHash);
  const sequences = await loadCourseSequences(db, eventId, courses.map((c) => c.id));
  const legsByPair = new Map<string, { fromId: string; toId: string; from: Pt; to: Pt; via?: Pt; courses: Set<string> }>();
  for (const [id, { seq, orderMode }] of sequences) {
    if (orderMode !== "ordered") continue;
    const viaOf = new Map(seq.flatMap((c) => (c.via ? [[c.via.id, { x: c.via.xMm, y: c.via.yMm }] as const] : [])));
    for (const leg of editorCourseLayer(id, seq, "ordered", { legStyle: true }).derivation.courses[0]?.legs ?? []) {
      if (leg.style === "marked_route" || leg.points.length < 2 || leg.from === leg.to) continue;
      const key = course.legPairKey(leg.from, leg.to);
      const known = legsByPair.get(key);
      if (known) { known.courses.add(id); continue; }
      const via = leg.crossing ? viaOf.get(leg.crossing) : undefined;
      legsByPair.set(key, { fromId: leg.from, toId: leg.to, from: leg.points[0], to: leg.points[leg.points.length - 1], ...(via ? { via } : {}), courses: new Set([id]) });
    }
  }
  const objects = legsByPair.size > 0 ? await obstaclesOf(db, eventId) : [];
  const pairs: Pair[] = [];
  for (const p of legsByPair.values()) {
    // An object closes the pair's way when every course running the pair is drawn with it.
    const obstacles = objects.filter((o) => o.courses === null || [...p.courses].every((c) => o.courses!.has(c))).map((o) => o.obstacle);
    const job = { from: p.from, to: p.to, ...(p.via ? { via: p.via } : {}), obstacles };
    pairs.push({ ...job, fromId: p.fromId, toId: p.toId, courses: [...p.courses], basis: autoRouteBasis({ documentHash: pin.documentHash, patchVersion, scale: pin.scale, ...job }) });
  }
  return { pairs, documentHash: pin.documentHash, patch, scale: pin.scale };
}

let workerStarts = 0;
/** For tests: how many worker threads the searchers have started. */
export const _autoRouteWorkerStarts = (): number => workerStarts;

export interface AutoRouteSearcher {
  /** One job's route; a job that fails or runs out of time is `ok: false`. Rejects when the worker cannot be prepared (the document does not decode). */
  searchOne(job: AutoRouteJob): Promise<AutoRouteResult>;
  /** Ends the worker; every exit path of a refresh calls it. */
  close(): Promise<void>;
}

/**
 * One worker thread for a refresh's searches (`print-worker-host.ts`'s
 * way): started on the first job, holding the decoded, patched and
 * classified document, a job at a time, each with its own time limit. A
 * job that times out or kills the worker ends it; the next job starts a
 * new one.
 */
export function openAutoRouteSearcher(init: AutoRouteInit, opts: { jobTimeoutMs?: number } = {}): AutoRouteSearcher {
  const timeoutMs = opts.jobTimeoutMs ?? AUTO_ROUTE_JOB_TIMEOUT_MS;
  interface Live { worker: Worker; ready: Promise<void>; dead: boolean; fail: (err: Error) => void; job: { id: number; settle: (r: AutoRouteResult) => void } | null }
  let live: Live | null = null;
  let closed = false;
  let nextId = 1;
  let busy = false;

  const start = (): Live => {
    workerStarts++;
    // A private copy on the transfer list: the document is not cloned per structured-clone rules, and a restart copies again.
    const copy = new Uint8Array(init.bytes);
    const worker = new Worker(workerBootstrap(new URL("./leg-routes-auto-worker", import.meta.url), import.meta.url), {
      eval: true, workerData: { bytes: copy, patch: init.patch, groundMPerMm: init.groundMPerMm } satisfies AutoRouteInit, transferList: [copy.buffer],
    });
    worker.unref();
    let readyOk!: () => void;
    let readyFail!: (err: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyOk = resolve; readyFail = reject; });
    ready.catch(() => undefined);
    const me: Live = {
      worker, ready, dead: false,
      job: null,
      fail: (err) => {
        me.dead = true;
        if (live === me) live = null;
        readyFail(err);
        const job = me.job;
        me.job = null;
        job?.settle({ ok: false, error: err.message });
        void worker.terminate();
      },
    };
    worker.on("message", (m: AutoRouteWorkerMessage) => {
      if (m.type === "ready") readyOk();
      else if (m.type === "error") me.fail(new Error(m.message));
      else if (me.job && me.job.id === m.id) {
        const job = me.job;
        me.job = null;
        job.settle(m.type === "route" ? { ok: true, points: m.points } : { ok: false, error: m.message });
      }
    });
    worker.on("error", (err) => me.fail(err instanceof Error ? err : new Error(String(err))));
    worker.on("exit", (code) => me.fail(new Error(`route worker exited with code ${code}`)));
    return me;
  };

  return {
    async searchOne(job) {
      // One job at a time: the caller awaits each (a second would take the first's answer).
      if (busy) throw new Error("the route searcher takes one job at a time");
      busy = true;
      try { return await searchOne(job); } finally { busy = false; }
    },
    async close() {
      closed = true;
      const mine = live;
      live = null;
      if (mine) {
        mine.job?.settle({ ok: false, error: "the route search was closed" });
        mine.job = null;
        await mine.worker.terminate();
      }
    },
  };

  async function searchOne(job: AutoRouteJob): Promise<AutoRouteResult> {
    {
      if (closed) return { ok: false, error: "the route search was closed" };
      // A worker that died (a timeout, an exit) is never reused: the next job starts a new one.
      if (live?.dead) live = null;
      const mine = live ?? (live = start());
      // The document is prepared within one job's time; a worker that cannot prepare it is no way to search.
      let timer: NodeJS.Timeout | undefined;
      const prepared = await Promise.race([
        mine.ready.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]).finally(() => clearTimeout(timer));
      if (!prepared) {
        mine.fail(new Error(`route worker not ready within ${timeoutMs} ms`));
        throw new Error(`route worker not ready within ${timeoutMs} ms`);
      }
      // It died while the document was being prepared (after `ready`): this job is lost, the next one starts afresh.
      if (mine.dead) return { ok: false, error: "the route worker stopped before the search started" };
      return new Promise<AutoRouteResult>((resolve) => {
        const id = nextId++;
        const timeout = setTimeout(() => mine.fail(new Error(`route search exceeded ${timeoutMs} ms`)), timeoutMs);
        mine.job = { id, settle: (r) => { clearTimeout(timeout); resolve(r); } };
        mine.worker.postMessage({ type: "search", id, job } satisfies AutoRouteWorkerRequest);
      });
    }
  }
}

export interface RefreshAutoRoutesOptions {
  /** The searches of one chunk (tests), one result per job in order; one worker thread for the whole refresh by default. A rejection fails the chunk. */
  search?: (data: AutoRouteWorkerData) => Promise<AutoRouteResult[]>;
  chunk?: number;
}

const samePoints = (a: unknown, b: readonly Pt[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Pairs whose search failed, by event: `pairKey|basis`. A failure rests on
 * the pair's inputs, so it is not searched again until its basis changes
 * (or the process restarts: in memory, no migration).
 */
const failedPairs = new Map<bigint, Set<string>>();

/**
 * Brings the event's automatic routes up to date: searches every pair
 * whose basis changed, a chunk at a time, writes each chunk's rows and
 * computes the climbs they cleared. A pair whose search fails is logged
 * and left; the others of its chunk are written, and the first failure
 * is thrown at the end. A chunk whose search cannot run at all leaves
 * its pairs for the next refresh. A node that does not hold the event's
 * lease does nothing. Returns the number of pairs written.
 */
export async function refreshAutoRoutes(db: PrismaClient, eventId: bigint, opts: RefreshAutoRoutesOptions = {}): Promise<number> {
  // Not the lease holder: no search, no write; the holder refreshes (§7.5 "When").
  if (!(await mayRunBackgroundJob(db, eventId, "leg-routes"))) return 0;
  const found = await pairsOf(db, eventId);
  if (!found) return 0;
  const rows = await db.legRoute.findMany({ where: { eventId, autoBasis: { not: null } }, select: { fromControlId: true, toControlId: true, autoBasis: true } });
  const current = new Map(rows.map((r) => [course.legPairKey(r.fromControlId, r.toControlId), r.autoBasis]));
  const memo = (p: Pair) => `${course.legPairKey(p.fromId, p.toId)}|${p.basis}`;
  // What failed under an older basis is forgotten.
  const failed = failedPairs.get(eventId);
  if (failed) {
    const live = new Set(found.pairs.map(memo));
    for (const key of failed) if (!live.has(key)) failed.delete(key);
    if (failed.size === 0) failedPairs.delete(eventId);
  }
  const stale = found.pairs.filter((p) => current.get(course.legPairKey(p.fromId, p.toId)) !== p.basis && !failedPairs.get(eventId)?.has(memo(p)));
  if (stale.length === 0) return 0;
  const doc = await db.mapDocument.findUnique({ where: { hash: found.documentHash }, select: { bytes: true } });
  if (!doc?.bytes) return 0;
  const init: AutoRouteInit = { bytes: doc.bytes, patch: found.patch, groundMPerMm: found.scale / 1000 };
  const searcher = openAutoRouteSearcher(init);
  const search = opts.search ?? (async (data: AutoRouteWorkerData) => {
    const out: AutoRouteResult[] = [];
    for (const job of data.jobs) out.push(await searcher.searchOne(job));
    return out;
  });
  const size = Math.max(1, opts.chunk ?? AUTO_ROUTE_CHUNK);
  let written = 0;
  let failure: unknown;
  // The courses whose computed climb this refresh cleared and that are not computed again yet.
  const pending = new Set<string>();
  try {
    for (let at = 0; at < stale.length; at += size) {
      const chunk = stale.slice(at, at + size);
      let results: AutoRouteResult[];
      try {
        results = await search({ ...init, jobs: chunk.map(({ from, to, via, obstacles }) => ({ from, to, ...(via ? { via } : {}), obstacles })) });
      } catch (err) {
        failure ??= err;
        continue;
      }
      // A checkout can start while a chunk is searched: its rows are not written.
      if (!(await mayRunBackgroundJob(db, eventId, "leg-routes"))) break;
      // Courses that gained a pair while the chunk was searched are read along its route too (CRS-048).
      const fresh = await coursesByPair(db, eventId);
      for (const [i, p] of chunk.entries()) {
        const result = results[i];
        if (!result?.ok) {
          const error = result ? result.error : "no result";
          console.warn(`[leg-routes] event ${eventId} pair ${p.fromId} → ${p.toId}: ${error}`);
          let set = failedPairs.get(eventId);
          if (!set) failedPairs.set(eventId, (set = new Set()));
          set.add(memo(p));
          failure ??= new Error(`route search of pair ${p.fromId} → ${p.toId} failed: ${error}`);
          continue;
        }
        // No way at all: the line, as a pair without a route.
        const points = (result.points ?? []).slice(0, course.LEG_ROUTE_MAX_POINTS).map((v) => ({ x: round(v.x), y: round(v.y) }));
        try {
          const done = await db.$transaction(async (tx) => {
            const pair = { eventId, fromControlId: p.fromId, toControlId: p.toId };
            // The controls may be gone since the pairs were read.
            if ((await tx.control.count({ where: { eventId, id: { in: [p.fromId, p.toId] }, removed: false } })) !== 2) return null;
            const existing = await tx.legRoute.findFirst({ where: { ...pair, autoBasis: { not: null } }, select: { id: true, chosen: true, points: true } });
            const data = { points, source: "computed", model: AUTO_ROUTE_MODEL, autoBasis: p.basis };
            let chosen = existing?.chosen ?? false;
            if (existing) await tx.legRoute.update({ where: { id: existing.id }, data });
            else {
              // Chosen unless a person chose a route for the pair.
              chosen = (await tx.legRoute.count({ where: { ...pair, chosen: true } })) === 0;
              await tx.legRoute.create({ data: { ...pair, ...data, chosen } });
            }
            // The climb is read along another polyline only when the chosen route's vertices changed: a new row
            // without points is the line the climb was read along already.
            const changed = chosen && !samePoints(existing?.points ?? [], points);
            const cleared = changed
              ? await clearComputedClimbs(tx, eventId, [...new Set([...p.courses, ...(fresh.get(course.legPairKey(p.fromId, p.toId)) ?? [])])], { emit: true })
              : [];
            return { cleared };
          });
          if (done) {
            written++;
            for (const id of done.cleared) pending.add(id);
          }
        } catch (err) {
          // Two refreshes of one pair, a person choosing at the same moment, a control deleted meanwhile: the next refresh settles it.
          if (!(err instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2003", "P2025"].includes(err.code))) failure ??= err;
        }
      }
      // The climbs this chunk cleared are computed now, not when the whole refresh ends (CRS-070).
      if (pending.size > 0) {
        const ids = [...pending];
        pending.clear();
        await refreshComputedClimbs(db, eventId, ids);
      }
    }
  } finally {
    await searcher.close();
    // Whatever stopped the loop, the climbs it cleared are computed again.
    if (pending.size > 0) await refreshComputedClimbs(db, eventId, [...pending]);
  }
  if (failure) throw failure;
  return written;
}

// ---- the queue ----------------------------------------------------------------

/** One refresh per event at a time; an event asked for again while it runs is run once more after. In memory: lost on a restart, and the next edit asks again. */
const running = new Map<bigint, { again: boolean; done: Promise<void> }>();

/** After an edit has committed: the event's automatic routes are refreshed in the background. Never throws. */
export function enqueueAutoRoutes(db: PrismaClient, eventId: bigint): void {
  if (process.env.AUTO_LEG_ROUTES === "off") return;
  const state = running.get(eventId);
  if (state) { state.again = true; return; }
  const entry = { again: false, done: Promise.resolve() };
  entry.done = (async () => {
    do {
      entry.again = false;
      try {
        await refreshAutoRoutes(db, eventId);
      } catch (err) {
        console.warn(`[leg-routes] automatic routes of event ${eventId} not refreshed:`, err);
      }
    } while (entry.again);
    running.delete(eventId);
  })();
  running.set(eventId, entry);
}

/** Resolves when no refresh is running (tests, shutdown). */
export async function drainAutoRoutes(): Promise<void> {
  while (running.size > 0) await Promise.all([...running.values()].map((s) => s.done));
}
