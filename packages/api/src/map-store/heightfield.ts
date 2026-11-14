/**
 * Height-field rows and their derive (docs/map-storage.md §4.7; research
 * 10 §4).
 *
 * A `map_heightfields` row is keyed `(document_hash, source, version)`:
 * `source = 'contours'` is `deriveTerrain(doc)` with the defaults
 * (docs/map-terrain.md §5.5), `version` is `TERRAIN_VERSION`. Rows are
 * written once with `createMany … skipDuplicates`, never updated, and
 * cascade with their document; a row without bytes records a document
 * without contours. A missing row is derived on demand through the same
 * path as import stage 10, in a worker thread of its own, one derive at
 * a time per instance.
 */

import { Worker } from "node:worker_threads";
// Leaf modules only: this file is in the router's type graph, which the web compiles too.
import { RASTER_RULES } from "@oxygen/shared/src/terrain/graph/raster.js";
import { TERRAIN_VERSION, type HeightFieldHeader } from "@oxygen/shared/src/terrain/field/types.js";
import type { TerrainReport } from "@oxygen/shared/src/terrain/solve/types.js";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { workerBootstrap } from "../worker-bootstrap.js";
import { getBlob } from "./blob-store.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** The only source today; a DEM-based field (H10) takes its own value. */
export const HEIGHTFIELD_SOURCE = "contours";
/** Under Cloud Run's 300 s request timeout, so the lazy route answers itself. */
export const HEIGHTFIELD_DERIVE_TIMEOUT_MS = 240_000;
/** A failed derive is not retried on this instance for this long. */
export const HEIGHTFIELD_FAILURE_MEMO_MS = 10 * 60_000;
/** The graph raster's own budget (docs/map-terrain.md §2.4): the default cap refuses nothing. */
export const HEIGHTFIELD_GRAPH_BUDGET_CELLS = RASTER_RULES.maxCells;
export const HEIGHTFIELD_CONTENT_TYPE = "application/vnd.oxygen.heightfield";

/** `MAP_HEIGHTFIELD_MAX_CELLS` when it is a positive integer, else the graph budget. */
export function heightfieldMaxCells(env: string | undefined = process.env.MAP_HEIGHTFIELD_MAX_CELLS): number {
  if (env === undefined || env === "") return HEIGHTFIELD_GRAPH_BUDGET_CELLS;
  const n = Number(env);
  if (Number.isSafeInteger(n) && n > 0) return n;
  console.warn(`[map-heightfield] ignoring MAP_HEIGHTFIELD_MAX_CELLS=${JSON.stringify(env)}: not a positive integer`);
  return HEIGHTFIELD_GRAPH_BUDGET_CELLS;
}

// ---- pure helpers -------------------------------------------------------------

export const heightfieldUrl = (hash: string, version: number = TERRAIN_VERSION): string => `/api/map-documents/${hash}/height.bin?v=${version}`;

export const heightfieldEtag = (hash: string, version: number = TERRAIN_VERSION, source: string = HEIGHTFIELD_SOURCE): string => `"${hash}/height/${source}/${version}"`;

/** `?v=`: a positive safe integer without sign or leading zeros, else null. */
export function parseTerrainVersion(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

interface HeaderSummary {
  unitsPerMm?: unknown;
  bounds?: { minX?: unknown; minY?: unknown; maxX?: unknown; maxY?: unknown } | null;
}

/**
 * Upper bound of the graph raster's cells from the stored header summary
 * (§3): the document's bounds plus the raster's 2 mm pad on each side at
 * the 0.1 mm cell, clamped to the budget the raster coarsens to
 * (docs/map-terrain.md §2.4). `null` when the summary has no usable bounds.
 */
export function estimateGraphCells(summary: unknown): number | null {
  const s = (summary ?? {}) as HeaderSummary;
  const u = typeof s.unitsPerMm === "number" && s.unitsPerMm > 0 ? s.unitsPerMm : null;
  const b = s.bounds;
  if (!u || !b) return null;
  const { minX, minY, maxX, maxY } = b;
  if (typeof minX !== "number" || typeof minY !== "number" || typeof maxX !== "number" || typeof maxY !== "number" || maxX < minX || maxY < minY) return null;
  const pad = 2 * RASTER_RULES.padMm;
  const cells = (((maxX - minX) / u + pad) * ((maxY - minY) / u + pad)) / (RASTER_RULES.cellMm * RASTER_RULES.cellMm);
  return Math.min(HEIGHTFIELD_GRAPH_BUDGET_CELLS, Math.ceil(cells));
}

export function isOverCap(summary: unknown, maxCells: number = heightfieldMaxCells()): boolean {
  const est = estimateGraphCells(summary);
  return est !== null && est > maxCells;
}

// ---- worker -------------------------------------------------------------------

export interface HeightfieldWorkerData {
  /** The encoded map document. */
  bytes: Uint8Array;
}

/** `heightfield-worker.ts` → host. */
export type HeightfieldWorkerMessage =
  | { type: "done"; bytes: Uint8Array; header: HeightFieldHeader; report: TerrainReport }
  | { type: "none" }
  | { type: "error"; message: string };

export type DerivedHeightfield =
  | { kind: "field"; bytes: Uint8Array; header: HeightFieldHeader; report: TerrainReport }
  | { kind: "none" };

/** One derive in a worker thread of its own, terminated as soon as it settles. */
export function deriveHeightfieldInWorker(bytes: Uint8Array, opts: { timeoutMs?: number } = {}): Promise<DerivedHeightfield> {
  const timeoutMs = opts.timeoutMs ?? HEIGHTFIELD_DERIVE_TIMEOUT_MS;
  const workerData: HeightfieldWorkerData = { bytes };
  return new Promise<DerivedHeightfield>((resolve, reject) => {
    const worker = new Worker(workerBootstrap(new URL("./heightfield-worker", import.meta.url), import.meta.url), { eval: true, workerData });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`height-field derive exceeded ${timeoutMs} ms`))), timeoutMs);
    worker.on("message", (m: HeightfieldWorkerMessage) => {
      if (m.type === "done") finish(() => resolve({ kind: "field", bytes: m.bytes, header: m.header, report: m.report }));
      else if (m.type === "none") finish(() => resolve({ kind: "none" }));
      else finish(() => reject(new Error(m.message)));
    });
    worker.on("error", (err) => finish(() => reject(err)));
    worker.on("exit", (code) => finish(() => reject(new Error(`height-field worker exited with code ${code}`))));
  });
}

// ---- rows ---------------------------------------------------------------------

export interface HeightfieldRow {
  bytes: Buffer | null;
  header: HeightFieldHeader | null;
  report: TerrainReport | null;
}

export async function readHeightfield(db: Db, hash: string, version: number = TERRAIN_VERSION, source: string = HEIGHTFIELD_SOURCE): Promise<HeightfieldRow | null> {
  const row = await db.mapHeightfield.findUnique({
    where: { documentHash_source_version: { documentHash: hash, source, version } },
    select: { bytes: true, header: true, report: true },
  });
  if (!row) return null;
  return {
    bytes: row.bytes ? Buffer.from(row.bytes) : null,
    header: (row.header as HeightFieldHeader | null) ?? null,
    report: (row.report as TerrainReport | null) ?? null,
  };
}

/** Whether a row exists, without reading its bytes. */
async function rowState(db: Db, hash: string): Promise<{ hasBytes: boolean; header: Prisma.JsonValue; report: Prisma.JsonValue } | null> {
  const row = await db.mapHeightfield.findUnique({
    where: { documentHash_source_version: { documentHash: hash, source: HEIGHTFIELD_SOURCE, version: TERRAIN_VERSION } },
    select: { sizeBytes: true, header: true, report: true },
  });
  return row ? { hasBytes: row.sizeBytes !== null, header: row.header, report: row.report } : null;
}

async function writeHeightfield(db: Db, hash: string, derived: DerivedHeightfield): Promise<void> {
  const data: Prisma.MapHeightfieldCreateManyInput =
    derived.kind === "field"
      ? {
          documentHash: hash, source: HEIGHTFIELD_SOURCE, version: TERRAIN_VERSION,
          bytes: new Uint8Array(derived.bytes), sizeBytes: derived.bytes.byteLength,
          header: JSON.parse(JSON.stringify(derived.header)) as Prisma.InputJsonObject,
          report: JSON.parse(JSON.stringify(derived.report)) as Prisma.InputJsonObject,
        }
      : { documentHash: hash, source: HEIGHTFIELD_SOURCE, version: TERRAIN_VERSION };
  await db.mapHeightfield.createMany({ data: [data], skipDuplicates: true });
}

// ---- derive on a miss ---------------------------------------------------------

export type HeightfieldResult =
  | { state: "ready"; bytes: Buffer; header: HeightFieldHeader; report: TerrainReport }
  | { state: "none" }
  | { state: "over-cap" }
  | { state: "failed" }
  | { state: "missing" };

export interface DeriveOptions {
  /** The deriver (tests); defaults to the worker. */
  derive?: (bytes: Uint8Array) => Promise<DerivedHeightfield>;
  maxCells?: number;
}

/** Derives in flight on this instance, by key: concurrent callers share one. */
const inFlight = new Map<string, Promise<HeightfieldResult>>();
/** Failed derives by key → retry not before this time. */
const failedUntil = new Map<string, number>();
/** One derive at a time per instance bounds the memory (§4.7, measured ~1.1 GB at the budget). */
let queue: Promise<unknown> = Promise.resolve();
function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/** Test seam: forget in-flight derives and failure memos. */
export function resetHeightfieldState(): void {
  inFlight.clear();
  failedUntil.clear();
}

/**
 * The current `contours` row, derived and written when missing. `missing`
 * when there is no such document; `over-cap` when its estimate is over
 * the cap (logged, nothing written); `failed` when the derive failed now
 * or in the last 10 minutes (nothing written). Never throws for a derive
 * failure; a database error propagates.
 */
export function getOrDeriveHeightfield(db: Db, hash: string, opts: DeriveOptions = {}): Promise<HeightfieldResult> {
  const key = `${hash}/${HEIGHTFIELD_SOURCE}/${TERRAIN_VERSION}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const p = (async (): Promise<HeightfieldResult> => {
    const existing = await readHeightfield(db, hash);
    if (existing) return asResult(existing);
    const doc = await db.mapDocument.findUnique({ where: { hash }, select: { header: true } });
    if (!doc) return { state: "missing" };
    const maxCells = opts.maxCells ?? heightfieldMaxCells();
    if (isOverCap(doc.header, maxCells)) {
      console.warn(`[map-heightfield] no field for ${hash}: about ${estimateGraphCells(doc.header)} graph cells is over the cap of ${maxCells}`);
      return { state: "over-cap" };
    }
    const until = failedUntil.get(key);
    if (until !== undefined && until > Date.now()) return { state: "failed" };
    failedUntil.delete(key);
    const derived = await serialised(async () => {
      // A derive queued behind another may find the row written meanwhile (another instance).
      const again = await readHeightfield(db, hash);
      if (again) return again;
      const bytes = await getBlob(db, "map_documents", hash);
      if (!bytes) return null;
      const started = Date.now();
      try {
        const out = await (opts.derive ?? deriveHeightfieldInWorker)(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        await writeHeightfield(db, hash, out);
        console.log(`[map-heightfield] derived ${hash}: ${out.kind === "field" ? `${out.header.width}×${out.header.height} at ${out.header.cellMm} mm, ${out.bytes.byteLength} B` : "no contours"} in ${Date.now() - started} ms`);
        return out;
      } catch (err: unknown) {
        failedUntil.set(key, Date.now() + HEIGHTFIELD_FAILURE_MEMO_MS);
        console.error(`[map-heightfield] derive ${hash} failed:`, err instanceof Error ? err.message : err);
        return "failed" as const;
      }
    });
    if (derived === null) return { state: "missing" };
    if (derived === "failed") return { state: "failed" };
    if ("kind" in derived) {
      return derived.kind === "none"
        ? { state: "none" }
        : { state: "ready", bytes: Buffer.from(derived.bytes.buffer, derived.bytes.byteOffset, derived.bytes.byteLength), header: derived.header, report: derived.report };
    }
    return asResult(derived);
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

function asResult(row: HeightfieldRow): HeightfieldResult {
  return row.bytes && row.header && row.report ? { state: "ready", bytes: row.bytes, header: row.header, report: row.report } : { state: "none" };
}

/**
 * Import stage 10 (docs/map-storage.md §6.1): make sure the height-field
 * row exists. Never throws — the field is cache; a failure is logged and
 * the route derives on a later request.
 */
export async function deriveDocumentHeightfield(db: Db, hash: string, opts: DeriveOptions = {}): Promise<void> {
  try {
    // Existence without the bytes: a stored row costs no ~8 MB read here.
    if (await rowState(db, hash)) return;
    await getOrDeriveHeightfield(db, hash, opts);
  } catch (err: unknown) {
    console.error(`[map-heightfield] derive ${hash} failed:`, err instanceof Error ? err.message : err);
  }
}

// ---- descriptor -----------------------------------------------------------------

export type TerrainState = "ready" | "none" | "over-cap" | "pending";

export interface TerrainDescriptor {
  state: TerrainState;
  source: typeof HEIGHTFIELD_SOURCE;
  version: number;
  /** The route, `?v=` current; null when there is nothing to fetch. */
  url: string | null;
  /** `report.share.decided` (the 3D gate's input, answer 7); null unless ready. */
  decided: number | null;
}

export interface TerrainReview {
  state: TerrainState;
  source: typeof HEIGHTFIELD_SOURCE;
  version: number;
  url: string | null;
  report: TerrainReport | null;
  field: { width: number; height: number; cellMm: number } | null;
}

/**
 * The review's terrain block (§4.7 "Descriptor"): the row only — it
 * never waits for a derive. `header` is the document's stored summary,
 * read for the over-cap check when there is no row.
 */
export async function terrainReview(db: Db, hash: string, documentSummary?: unknown): Promise<TerrainReview> {
  const base = { source: HEIGHTFIELD_SOURCE, version: TERRAIN_VERSION } as const;
  const row = await rowState(db, hash);
  if (row?.hasBytes) {
    const h = row.header as HeightFieldHeader;
    return { ...base, state: "ready", url: heightfieldUrl(hash), report: row.report as unknown as TerrainReport, field: { width: h.width, height: h.height, cellMm: h.cellMm } };
  }
  if (row) return { ...base, state: "none", url: null, report: null, field: null };
  const summary = documentSummary !== undefined ? documentSummary : (await db.mapDocument.findUnique({ where: { hash }, select: { header: true } }))?.header;
  if (isOverCap(summary)) return { ...base, state: "over-cap", url: null, report: null, field: null };
  return { ...base, state: "pending", url: heightfieldUrl(hash), report: null, field: null };
}

/** `course.mapMetadata.terrain`: the review's block without the report. */
export async function terrainDescriptor(db: Db, hash: string, documentSummary?: unknown): Promise<TerrainDescriptor> {
  const r = await terrainReview(db, hash, documentSummary);
  const decided = r.report?.share?.decided;
  return { state: r.state, source: r.source, version: r.version, url: r.url, decided: typeof decided === "number" ? decided : null };
}
