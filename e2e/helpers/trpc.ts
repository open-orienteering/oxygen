/**
 * Batch-aware matching of tRPC responses.
 *
 * The web client uses `httpBatchLink`, so calls issued in the same tick
 * share one HTTP request: `/trpc/competition.dbStatus,cardReadout.readout`.
 * A predicate like `url.includes("/trpc/cardReadout.readout")` only matches
 * when the procedure happens to be first in the batch, and a background
 * poll (dbStatus every 5 s, counterState, …) landing in the same tick
 * silently hides the response from the test. Match on the comma-separated
 * procedure list instead, and judge success per call, not per request
 * (a mixed batch answers 207).
 */
import type { Page, Response } from "@playwright/test";

/** Procedure names carried by a tRPC request URL, in batch order. */
export function trpcProcedures(url: string): string[] {
  const { pathname } = new URL(url);
  const at = pathname.indexOf("/trpc/");
  if (at < 0) return [];
  return decodeURIComponent(pathname.slice(at + "/trpc/".length))
    .split(",")
    .filter(Boolean);
}

/** True when `resp` answers (among others) a call to `procedure`. */
export function isTrpcResponse(resp: Response, procedure: string): boolean {
  return trpcProcedures(resp.url()).includes(procedure);
}

/**
 * True when `resp` carries a successful result for `procedure`. Reads the
 * body: in a batch each call has its own `{ result }` or `{ error }` slot.
 */
export async function isTrpcSuccess(
  resp: Response,
  procedure: string,
): Promise<boolean> {
  const index = trpcProcedures(resp.url()).indexOf(procedure);
  if (index < 0) return false;
  if (resp.status() !== 200 && resp.status() !== 207) return false;
  const body = (await resp.json().catch(() => null)) as unknown;
  const slot = Array.isArray(body) ? body[index] : body;
  return !!slot && typeof slot === "object" && "result" in slot;
}

/**
 * Wait for a successful response to `procedure` on `page`. Arm it before
 * the action that triggers the call — a response that has already
 * arrived is not replayed.
 */
export function waitForTrpc(
  page: Page,
  procedure: string,
  options?: { timeout?: number },
): Promise<Response> {
  return page.waitForResponse((resp) => isTrpcSuccess(resp, procedure), options);
}
