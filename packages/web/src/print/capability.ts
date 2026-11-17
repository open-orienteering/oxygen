/**
 * Whether this device composes a print job itself (docs/course-print.md
 * §8.6 "Capability", G16): the job's cost in composed A4-equivalents
 * against a limit from the device's memory. The limits are estimates from
 * §11.5's page sizes (about 1.2 MB of compressed content per dense A4,
 * held about three times at `save()` and in the Blob, beside the decoded
 * document), not device measurements. Above the limit, or without a
 * `Worker`, the server composes (`maps.pdf`); the bytes are the same.
 *
 * Types only from `@oxygen/shared/print`: this module is on the main thread.
 */

import type { PrintJob } from "@oxygen/shared/print";

export interface DeviceEnv {
  /** `typeof Worker !== "undefined"`. */
  worker: boolean;
  /** `navigator.deviceMemory` (GiB, Chromium only; capped at 8). */
  deviceMemory?: number;
  /** `matchMedia("(pointer: coarse)")`: a phone or tablet, where `deviceMemory` is unknown. */
  coarsePointer: boolean;
}

const A4_MM2 = 210 * 297;

/** The composed pages of a job in A4-equivalents of their paper; copies are free (they share one content stream, §4.5). */
export function printCost(job: Pick<PrintJob, "sheets">): number {
  let cost = 0;
  for (const s of job.sheets) {
    if ((s.copies ?? 1) < 1) continue;
    cost += (s.paper.widthMm * s.paper.heightMm) / A4_MM2;
  }
  return cost;
}

/** The largest job (A4-equivalents) this device composes; 0 = always the server. */
export function deviceLimit(env: DeviceEnv): number {
  if (!env.worker) return 0;
  const mem = env.deviceMemory;
  if (mem === undefined) return env.coarsePointer ? 8 : 24;
  if (mem < 2) return 0;
  if (mem < 4) return 8;
  if (mem < 8) return 24;
  return 64;
}

/** This browser's `DeviceEnv`. */
export function deviceEnv(): DeviceEnv {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { deviceMemory?: number }) : undefined;
  const mem = nav?.deviceMemory;
  return {
    worker: typeof Worker !== "undefined",
    ...(typeof mem === "number" && Number.isFinite(mem) ? { deviceMemory: mem } : {}),
    coarsePointer: typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches,
  };
}
