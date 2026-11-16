/**
 * Averaging selected GPS tracks in Map mode (docs/map-gps-tracks.md §4, §5.2; row G27): the passes sent to a module
 * worker (`average-worker-entry.ts`; `averageTracks` is synchronous and seconds long at the caps, §4.6), the worker's
 * pure handler, the client, and the result as one `mapTrack.import` item — unprojected to WGS 84 (§3.2), the sources
 * in `derivedFrom`, the single-pass ranges in `singlePass` (§1.1). Defaults only: the 15 m gate and 2 iterations
 * have no control (G27 plan).
 */

import { gpsTrack, type mapGeo } from "@oxygen/shared";
import type { TrackImportItem } from "../../../../../lib/editor/write-client";
import { MAX_TRACK_POINTS } from "./model";

type Line = gpsTrack.ProjectedTrack;

export interface AverageRequest {
  id: number;
  passes: Line[];
}
export type AverageResponse =
  | { id: number; ok: true; line: Line; singlePass: gpsTrack.TrackRange[] }
  | { id: number; ok: false; error: string };

/** The worker's handler: `averageTracks` with the defaults (§4.1); a `RangeError` is the answer's error. */
export function averageResponse(req: AverageRequest): AverageResponse {
  try {
    const r = gpsTrack.averageTracks(req.passes);
    return { id: req.id, ok: true, line: r.line, singlePass: r.singlePass };
  } catch (e) {
    return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The passes as the worker gets them: compact copies of the rows' trimmed lines. They are transferred, so the copies
 * are what is detached — the rows' lines stay in the projection and decimation caches.
 */
export function averagePasses(lines: readonly Line[]): Line[] {
  return lines.map((l) => ({ x: l.x.slice(), y: l.y.slice(), metresPerMm: l.metresPerMm }));
}

/** The average stored like an imported track (§5.2): or why it cannot be (`too-many-points`, §1.2 "Caps"; `not-projectable`). */
export function averageImport(
  frame: mapGeo.PaperFrame, result: { line: Line; singlePass: gpsTrack.TrackRange[] }, id: string, name: string, sources: readonly string[],
): { ok: true; item: TrackImportItem } | { ok: false; code: "too-many-points" | "not-projectable" } {
  if (result.line.x.length > MAX_TRACK_POINTS) return { ok: false, code: "too-many-points" };
  let track: gpsTrack.Track;
  try {
    track = gpsTrack.unprojectTrack(frame, result.line, name);
  } catch {
    return { ok: false, code: "not-projectable" };
  }
  return {
    ok: true,
    item: { id, name: name.slice(0, 200), sourceName: "", points: track.points, derivedFrom: [...sources], singlePass: result.singlePass.map((r) => ({ ...r })) },
  };
}

// ─── The client: one module worker per Map-mode session, one job at a time ──

export interface AverageWorkerLike {
  postMessage(msg: AverageRequest, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<AverageResponse>) => void) | null;
  onerror: ((e: ErrorEvent | Event) => void) | null;
  terminate(): void;
}

/** A job ended by `dispose` (leaving Map mode or the document): not an error to show. */
export class AverageCancelled extends Error {
  constructor() {
    super("Averaging was cancelled");
    this.name = "AverageCancelled";
  }
}

export interface Averager {
  /** The average of `passes` (copied, `averagePasses`); rejects with the worker's error. */
  run(passes: readonly Line[]): Promise<{ line: Line; singlePass: gpsTrack.TrackRange[] }>;
  /** Terminates the worker; a job in flight rejects. */
  dispose(): void;
}

export const createAverageWorker = (): AverageWorkerLike =>
  new Worker(new URL("./average-worker-entry.ts", import.meta.url), { type: "module" }) as unknown as AverageWorkerLike;

export function createAverager(createWorker: () => AverageWorkerLike = createAverageWorker): Averager {
  let worker: AverageWorkerLike | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: (r: { line: Line; singlePass: gpsTrack.TrackRange[] }) => void; reject: (e: Error) => void }>();
  const failAll = (e: Error) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  const get = (): AverageWorkerLike => {
    if (worker) return worker;
    const w = createWorker();
    w.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve({ line: e.data.line, singlePass: e.data.singlePass });
      else p.reject(new Error(e.data.error));
    };
    w.onerror = () => {
      failAll(new Error("The averaging worker failed"));
      w.terminate();
      if (worker === w) worker = null;
    };
    return (worker = w);
  };
  return {
    run(passes) {
      const copies = averagePasses(passes);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        get().postMessage({ id, passes: copies }, copies.flatMap((l) => [l.x.buffer, l.y.buffer]));
      });
    },
    dispose() {
      failAll(new AverageCancelled());
      worker?.terminate();
      worker = null;
    },
  };
}
