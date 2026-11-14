/**
 * Cloud-owned mutations in a batch of their own (row G18;
 * docs/offline-architecture.md "Non-critical data").
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
 * An export's ensure step (`layout.autoSheets`, docs/course-layout.md §7)
 * is best effort when the venue's cloud is unreachable: the box then prints
 * the sheets of its checkout copy (row G18). Answers the step's result, or
 * null when it was skipped; any other failure still throws.
 */
export async function ensureSheetsBestEffort<T>(ensure: () => Promise<T>): Promise<T | null> {
  try {
    return await ensure();
  } catch (err) {
    if (isCloudUnreachable(err)) return null;
    throw err;
  }
}
