/**
 * SYNC-14 (Sheets half): one node pushes each readout to the backup sheet.
 * The cloud does; a venue box that ships to a peer leaves it to the cloud
 * for an event checked out from there (the cloud pushes the shipped
 * `card.read` on ingest); a box-only event and a standalone box push.
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

let leased = true;
const client = {
  event: { findUnique: async () => ({ googleSheetsWebhookUrl: "https://sheets.example/hook" }) },
  eventLease: { findFirst: async () => (leased ? { id: "l1" } : null) },
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
    leased = true;
    expect(await pushesReadoutsToSheet(client, 1n)).toBe(true);
    expect(await pushes()).toBe(1);
  });

  it("a venue box with a peer leaves a checked-out event to the cloud", async () => {
    process.env.NODE_ROLE = "venue";
    process.env.SYNC_PEER_URL = "https://cloud.example";
    leased = true;
    expect(await pushesReadoutsToSheet(client, 1n)).toBe(false);
    expect(await pushes()).toBe(0);
  });

  it("a venue box with a peer pushes an event that lives only on the box", async () => {
    process.env.NODE_ROLE = "venue";
    process.env.SYNC_PEER_URL = "https://cloud.example";
    leased = false;
    expect(await pushes()).toBe(1);
  });

  it("a standalone venue box pushes itself", async () => {
    process.env.NODE_ROLE = "venue";
    delete process.env.SYNC_PEER_URL;
    leased = true;
    expect(await pushesReadoutsToSheet(client, 1n)).toBe(true);
    expect(await pushes()).toBe(1);
  });
});
