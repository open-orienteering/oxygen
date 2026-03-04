import { initTRPC } from "@trpc/server";
import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";

/** Context available to all tRPC procedures */
export interface Context {
  // Will be extended with auth, etc. in the future
}

export async function createContext(
  _opts: CreateFastifyContextOptions,
): Promise<Context> {
  return {};
}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;
export const createCallerFactory = t.createCallerFactory;
