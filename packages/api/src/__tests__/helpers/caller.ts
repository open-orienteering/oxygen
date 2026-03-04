/**
 * tRPC server-side caller factory for integration tests.
 *
 * Uses tRPC's createCallerFactory to call procedures directly without
 * an HTTP round-trip. The caller uses an empty context (matching current
 * production setup — no auth yet).
 */

import { createCallerFactory } from "../../trpc.js";
import { appRouter } from "../../routers/index.js";
import type { Context } from "../../trpc.js";

const createCaller = createCallerFactory(appRouter);

export function makeCaller(ctx: Context = {}) {
  return createCaller(ctx);
}
