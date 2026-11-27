// The terrain descriptor of `course.mapMetadata` for specs that read height fields
// (docs/map-storage.md §4.7; docs/course-elevation.md §3).

import type { Page } from "@playwright/test";
import { planeFieldBytes, readyDem } from "./dem-field";
import { trpcCall } from "./editor";

/**
 * Rewrites `course.mapMetadata`'s terrain descriptor in the batched tRPC responses (the n-th answer,
 * from 0, goes through `patch`; `null` leaves it), so the gate's other rows run on the demo map.
 * `always`: also when the event's map has no descriptor (the patch gets `{}`).
 */
export async function patchTerrainDescriptor(page: Page, patch: (terrain: Record<string, unknown>, n: number) => Record<string, unknown> | null, opts: { always?: boolean; contourInterval?: Record<string, unknown> | null } = {}): Promise<() => number> {
  let n = 0;
  await page.route(/\/trpc\/[^?]*course\.mapMetadata/, async (route) => {
    try {
    const res = await route.fetch();
    const procs = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^.*\/trpc\//, "")).split(",");
    const body = (await res.json()) as unknown;
    const arr = (Array.isArray(body) ? body : [body]) as { result?: { data?: { terrain?: Record<string, unknown> | null; contourInterval?: Record<string, unknown> | null } } }[];
    const data = arr[procs.indexOf("course.mapMetadata")]?.result?.data;
    if (data && opts.contourInterval !== undefined) data.contourInterval = opts.contourInterval;
    if (data && (data.terrain || opts.always)) data.terrain = patch(data.terrain ?? {}, n++) ?? data.terrain;
    await route.fulfill({ response: res, json: Array.isArray(body) ? arr : arr[0] });
    } catch {
      // the page closed while the request was in flight (teardown): nothing left to answer
    }
  });
  return () => n;
}

/** Metres of height per ground metre along x. */
export const PLANE_SLOPE = 0.05;
const FIELD_URL = "/api/map-documents/e2e-plane/height.bin?v=e2e";

export type PlaneTerrain = "contours" | "ground" | "none";

/** The contour interval the plane's descriptor states: confirmed at the field's own 5 m by default, so the numbers of the specs hold (docs/course-elevation.md §0.43). */
export interface PlaneInterval { assumedM: number; confirmedM: number | null }

/** docs/course-elevation.md §4's specs: the descriptor replaced by one of `kind`, and `height.bin` answered with the plane; returns the requests seen and a switch to fail them. */
export async function servePlane(page: Page, kind: PlaneTerrain, opts: { interval?: PlaneInterval } = {}): Promise<{ asked: string[]; fail: (on: boolean) => void }> {
  const asked: string[] = [];
  let failing = false;
  const interval = opts.interval ?? { assumedM: 5, confirmedM: 5 };
  await patchTerrainDescriptor(page, () => (
    kind === "none" ? { state: "none", url: null, decided: null, dem: null, interval }
      : { state: "ready", url: FIELD_URL, decided: 0.9, dem: kind === "ground" ? readyDem(FIELD_URL, 0.9) : null, interval }
  ), { always: true, contourInterval: { ...interval, from: "event", suspect: false } });
  let groundMPerMm: number | null = null;
  await page.route(/\/height\.bin/, async (route) => {
    const source = new URL(route.request().url()).searchParams.get("source") ?? "contours";
    asked.push(source);
    if (failing) return route.fulfill({ status: 500, body: "no" });
    groundMPerMm ??= (await trpcCall<{ scale: number }>("course.mapMetadata", undefined, false)).scale / 1000;
    await route.fulfill({ status: 200, contentType: "application/octet-stream", body: planeFieldBytes({ groundMPerMm, slope: PLANE_SLOPE, source }) });
  });
  return { asked, fail: (on) => { failing = on; } };
}
