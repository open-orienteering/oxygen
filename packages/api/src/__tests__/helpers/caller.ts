/**
 * tRPC server-side caller factory for integration tests.
 *
 * Uses tRPC's createCallerFactory to call procedures directly without
 * an HTTP round-trip. Pass the resolved Event when calling event-scoped
 * procedures; pass nothing (or null) for global procedures.
 */

import { createCallerFactory } from "../../trpc.js";
import { appRouter } from "../../routers/index.js";
import type { Context } from "../../trpc.js";
import type { EventRef } from "../../db.js";

const createCaller = createCallerFactory(appRouter);

export function makeCaller(event: EventRef | null = null) {
  const ctx: Context = { event };
  return createCaller(ctx);
}
