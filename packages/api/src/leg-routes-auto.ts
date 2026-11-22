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
import { storedObjectOf } from "./course-objects.js";
import { coursesRunningPair } from "./leg-routes.js";
import { eventPin } from "./map-store/event-document.js";
import { eventPatchOnPin } from "./map-store/patches.js";
import { workerBootstrap } from "./worker-bootstrap.js";

/** Bumped when the search changes what it finds: every automatic route is searched again. */
export const AUTO_ROUTE_VERSION = 1;
export const AUTO_ROUTE_MODEL = "shortest";
/** A batch of searches may take this long before it is given up (a long leg is a few seconds). */
export const AUTO_ROUTE_TIMEOUT_MS = 10 * 60_000;

type Pt = course.RoutePoint;

/** An uncrossable object of the course layer, as the search takes it. */
export interface AutoRouteObstacle { kind: "area" | "line"; coords: number[] }

export interface AutoRouteJob {
  from: Pt;
  to: Pt;
  via?: Pt;
  obstacles: AutoRouteObstacle[];
}

export interface AutoRouteWorkerData {
  /** The encoded map document and the event's patch on it. */
  bytes: Uint8Array;
  patch: mapDocument.MapPatch | null;
  groundMPerMm: number;
  jobs: AutoRouteJob[];
}

/** One per job, in order: the route's interior vertices (none: the line is the route), or null without a way. */
export type AutoRouteWorkerMessage = { type: "done"; routes: (Pt[] | null)[] } | { type: "error"; message: string };

interface Pair extends AutoRouteJob {
  fromId: string;
  toId: string;
  basis: string;
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
    pairs.push({ ...job, fromId: p.fromId, toId: p.toId, basis: autoRouteBasis({ documentHash: pin.documentHash, patchVersion, scale: pin.scale, ...job }) });
  }
  return { pairs, documentHash: pin.documentHash, patch, scale: pin.scale };
}

/** The searches in a worker thread of their own, terminated as soon as it settles. */
export function searchAutoRoutesInWorker(data: AutoRouteWorkerData, opts: { timeoutMs?: number } = {}): Promise<(Pt[] | null)[]> {
  const timeoutMs = opts.timeoutMs ?? AUTO_ROUTE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerBootstrap(new URL("./leg-routes-auto-worker", import.meta.url), import.meta.url), { eval: true, workerData: data });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`route search exceeded ${timeoutMs} ms`))), timeoutMs);
    worker.on("message", (m: AutoRouteWorkerMessage) => {
      if (m.type === "done") finish(() => resolve(m.routes));
      else finish(() => reject(new Error(m.message)));
    });
    worker.on("error", (err) => finish(() => reject(err)));
    worker.on("exit", (code) => finish(() => reject(new Error(`route worker exited with code ${code}`))));
  });
}

/**
 * Brings the event's automatic routes up to date: searches every pair
 * whose basis changed, writes the rows and computes the climbs they
 * cleared. Returns the number of pairs written.
 */
export async function refreshAutoRoutes(db: PrismaClient, eventId: bigint): Promise<number> {
  const found = await pairsOf(db, eventId);
  if (!found) return 0;
  const rows = await db.legRoute.findMany({ where: { eventId, autoBasis: { not: null } }, select: { fromControlId: true, toControlId: true, autoBasis: true } });
  const current = new Map(rows.map((r) => [course.legPairKey(r.fromControlId, r.toControlId), r.autoBasis]));
  const stale = found.pairs.filter((p) => current.get(course.legPairKey(p.fromId, p.toId)) !== p.basis);
  if (stale.length === 0) return 0;
  const doc = await db.mapDocument.findUnique({ where: { hash: found.documentHash }, select: { bytes: true } });
  if (!doc?.bytes) return 0;
  const routes = await searchAutoRoutesInWorker({
    bytes: new Uint8Array(doc.bytes), patch: found.patch, groundMPerMm: found.scale / 1000,
    jobs: stale.map(({ from, to, via, obstacles }) => ({ from, to, ...(via ? { via } : {}), obstacles })),
  });
  let written = 0;
  for (const [i, p] of stale.entries()) {
    // No way at all: the line, as a pair without a route.
    const points = (routes[i] ?? []).slice(0, course.LEG_ROUTE_MAX_POINTS).map((v) => ({ x: round(v.x), y: round(v.y) }));
    try {
      written += await db.$transaction(async (tx) => {
        const pair = { eventId, fromControlId: p.fromId, toControlId: p.toId };
        // The controls may be gone since the pairs were read.
        if ((await tx.control.count({ where: { eventId, id: { in: [p.fromId, p.toId] }, removed: false } })) !== 2) return 0;
        const existing = await tx.legRoute.findFirst({ where: { ...pair, autoBasis: { not: null } }, select: { id: true, chosen: true } });
        const data = { points, source: "computed", model: AUTO_ROUTE_MODEL, autoBasis: p.basis };
        let chosen = existing?.chosen ?? false;
        if (existing) await tx.legRoute.update({ where: { id: existing.id }, data });
        else {
          // Chosen unless a person chose a route for the pair.
          chosen = (await tx.legRoute.count({ where: { ...pair, chosen: true } })) === 0;
          await tx.legRoute.create({ data: { ...pair, ...data, chosen } });
        }
        if (chosen) await clearComputedClimbs(tx, eventId, await coursesRunningPair(tx, eventId, p.fromId, p.toId));
        return 1;
      });
    } catch (err) {
      // Two refreshes of one pair, or a person choosing at the same moment: the next refresh settles it.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2002" || err.code === "P2003"))) throw err;
    }
  }
  if (written > 0) await refreshComputedClimbs(db, eventId);
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
