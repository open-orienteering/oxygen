/**
 * Cloud-owned mutations in a batch of their own (row G18;
 * docs/system/offline-architecture.md "Non-critical data").
 *
 * A venue box forwards a tRPC batch to the cloud only when every
 * procedure in it is cloud-owned, and refuses a batch that mixes them with
 * local calls (`MIXED_BATCH`; run locally, the cloud-owned writes would be
 * lost at checkin). With layout writes cloud-owned, `httpBatchLink` could
 * otherwise put an editor write and a local call (the presence heartbeat)
 * into one request, so both clients split cloud-owned mutations onto their
 * own batch link.
 */

import { splitLink, type TRPCLink } from "@trpc/client";
import type { AnyTRPCRouter } from "@trpc/server";
import { isCloudOwnedMutation } from "@oxygen/shared";

/** True for an operation the venue forwards to the cloud. */
export function isCloudOwnedOp(op: { type: string; path: string }): boolean {
  return op.type === "mutation" && isCloudOwnedMutation(op.path);
}

/** Two copies of the same link: one carries only cloud-owned mutations, the other everything else. */
export function cloudOwnedApart<TRouter extends AnyTRPCRouter>(makeLink: () => TRPCLink<TRouter>): TRPCLink<TRouter> {
  return splitLink({ condition: isCloudOwnedOp, true: makeLink(), false: makeLink() });
}

/** The venue forwarder's typed refusal when the cloud is unreachable (`venueForwarder.ts`). */
export function isCloudUnreachable(err: unknown): boolean {
  const data = (err as { data?: { code?: unknown; reason?: unknown } | null } | null)?.data;
  return data?.code === "PRECONDITION_FAILED" && data.reason === "CLOUD_UNREACHABLE";
}

/**
 * A request that got no response (no network, the box gone): no tRPC
 * `data`, and a `TypeError` from `fetch` itself or as the client error's
 * cause, or the browser knows it is offline.
 */
export function isNetworkFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ((err as { data?: unknown }).data) return false;
  const cause = (err as { cause?: unknown }).cause;
  if (err instanceof TypeError || cause instanceof TypeError) return true;
  // A fetch given up on by its timeout signal (the drain's, the readout's):
  // the node did not answer in time, which is the same as unreachable.
  if (isTimeoutAbort(err) || isTimeoutAbort(cause)) return true;
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function isTimeoutAbort(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  // Only the timeout: a deliberate abort (unmount, cancelled query) is not
  // a statement about the network.
  return name === "TimeoutError";
}

/**
 * An export's ensure step (`layout.autoSheets`, docs/course-layout.md §7)
 * is best effort when the venue's cloud is unreachable — the box then
 * prints the sheets of its checkout copy (row G18) — and when the request
 * got no response, so the export prints the device's stored job (G17,
 * course-print.md §8.6 "Offline"). Answers the step's result, or null when
 * it was skipped; any other failure still throws.
 */
export async function ensureSheetsBestEffort<T>(ensure: () => Promise<T>): Promise<T | null> {
  try {
    return await ensure();
  } catch (err) {
    if (isCloudUnreachable(err) || isNetworkFailure(err)) return null;
    throw err;
  }
}

/**
 * A fetch that aborts after `ms`, on top of any signal the caller passes.
 * Combined by hand, not with `AbortSignal.any` / `AbortSignal.timeout`
 * (missing on older Safari), so the timeout applies everywhere. The abort
 * reason is a `TimeoutError` DOMException, as `AbortSignal.timeout` gives.
 */
export function withRequestTimeout(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  ms: number,
) {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const ctrl = new AbortController();
    const outer = init?.signal;
    const onOuterAbort = () => ctrl.abort(outer?.reason);
    if (outer) {
      if (outer.aborted) ctrl.abort(outer.reason);
      else outer.addEventListener("abort", onOuterAbort, { once: true });
    }
    const timer = setTimeout(() => ctrl.abort(new DOMException("The request timed out.", "TimeoutError")), ms);
    return fetchImpl(input, { ...init, signal: ctrl.signal }).finally(() => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    });
  };
}
