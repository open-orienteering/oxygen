/**
 * SYNC-14 (Sheets half): one node pushes each readout to the backup sheet.
 * The cloud does; a venue box that ships to a peer leaves it to the cloud
 * (which pushes the shipped `card.read` on ingest); a standalone box pushes.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { clearSheetsCache, pushesReadoutsToSheet, pushToGoogleSheet } from "../sheetsBackup.js";
import type { PrismaClient } from "../generated/prisma/client.js";

const saved = { role: process.env.NODE_ROLE, peer: process.env.SYNC_PEER_URL };
const realFetch = globalThis.fetch;

afterEach(() => {
  for (const [k, v] of [["NODE_ROLE", saved.role], ["SYNC_PEER_URL", saved.peer]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  globalThis.fetch = realFetch;
  clearSheetsCache();
});

const client = {
  event: { findUnique: async () => ({ googleSheetsWebhookUrl: "https://sheets.example/hook" }) },
} as unknown as PrismaClient;

async function pushes(): Promise<number> {
  const f = vi.fn(async () => new Response("ok"));
  globalThis.fetch = f as unknown as typeof fetch;
  pushToGoogleSheet(client, 1n, {} as never);
  await new Promise((r) => setTimeout(r, 10));
  return f.mock.calls.length;
}

describe("pushesReadoutsToSheet", () => {
  it("the cloud pushes", async () => {
    delete process.env.NODE_ROLE;
    expect(pushesReadoutsToSheet()).toBe(true);
    expect(await pushes()).toBe(1);
  });

  it("a venue box with a peer leaves it to the cloud", async () => {
    process.env.NODE_ROLE = "venue";
    process.env.SYNC_PEER_URL = "https://cloud.example";
    expect(pushesReadoutsToSheet()).toBe(false);
    expect(await pushes()).toBe(0);
  });

  it("a standalone venue box pushes itself", async () => {
    process.env.NODE_ROLE = "venue";
    delete process.env.SYNC_PEER_URL;
    expect(pushesReadoutsToSheet()).toBe(true);
    expect(await pushes()).toBe(1);
  });
});
