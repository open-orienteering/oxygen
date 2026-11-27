/**
 * How the cloud reads a venue's forwarded call (`x-oxygen-forwarded`,
 * package 20 / API-29): with the node secret it is the node, never a user;
 * without it the marker grants nothing and the identity header is not read.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContext } from "../trpc.js";
import { SYNC_FORWARDED_HEADER, SYNC_NODE_ID_HEADER, SYNC_SECRET_HEADER } from "../sync/nodeIdentity.js";

const ENV = ["AUTH_MODE", "SYNC_SHARED_SECRET", "DATABASE_URL"] as const;
const saved: Record<string, string | undefined> = {};

const ctxFor = (headers: Record<string, string>) =>
  createContext({ req: { headers } } as unknown as Parameters<typeof createContext>[0]);

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.AUTH_MODE = "proxy";
  process.env.SYNC_SHARED_SECRET = "node-secret";
  // An identity header is never resolved for a marked call; a dead database proves it.
  process.env.DATABASE_URL = "postgresql://nobody:nobody@127.0.0.1:1/none";
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("createContext and the forwarded marker", () => {
  it("a marked call with the node secret is the node: no user, nodeForward carries its id", async () => {
    const ctx = await ctxFor({
      [SYNC_FORWARDED_HEADER]: "1",
      [SYNC_SECRET_HEADER]: "node-secret",
      [SYNC_NODE_ID_HEADER]: "venue-3",
      "x-forwarded-email": "someone@example.org",
    });
    expect(ctx.nodeForward).toEqual({ nodeId: "venue-3" });
    expect(ctx.user).toBeNull();
    expect(ctx.identityEmail).toBeNull();
    expect(ctx.authEnabled).toBe(true);
  });

  it("a marked call with a wrong or missing secret is anonymous", async () => {
    for (const secret of [{ [SYNC_SECRET_HEADER]: "guess" }, {}]) {
      const ctx = await ctxFor({ [SYNC_FORWARDED_HEADER]: "1", [SYNC_NODE_ID_HEADER]: "venue-3", "x-forwarded-email": "someone@example.org", ...secret });
      expect(ctx.nodeForward).toBeNull();
      expect(ctx.user).toBeNull();
      expect(ctx.identityEmail).toBeNull();
    }
  });

  it("the secret without the marker is not a forward", async () => {
    const ctx = await ctxFor({ [SYNC_SECRET_HEADER]: "node-secret", [SYNC_NODE_ID_HEADER]: "venue-3" });
    expect(ctx.nodeForward).toBeNull();
  });

  it("a node with no configured secret never forwards", async () => {
    delete process.env.SYNC_SHARED_SECRET;
    const ctx = await ctxFor({ [SYNC_FORWARDED_HEADER]: "1", [SYNC_SECRET_HEADER]: "anything" });
    expect(ctx.nodeForward).toBeNull();
  });
});
