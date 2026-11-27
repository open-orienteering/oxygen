import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { httpPeerTransport } from "../sync/shipper.js";
import { httpLeasePeer } from "../sync/lease.js";
import { isPeerTimeout } from "../sync/peerTimeouts.js";

let server: Server;
let baseUrl: string;
let mode: "silent" | "json";

beforeEach(async () => {
  mode = "silent";
  server = createServer((req, res) => {
    if (mode === "silent") return; // accept the request, never answer
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ result: { data: { synced: [], failed: [] } } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("peer call timeouts (SYNC-21)", () => {
  it("push rejects when the peer never answers", async () => {
    const t = httpPeerTransport(baseUrl, "s", { callTimeoutMs: 200 });
    const started = Date.now();
    const err = await t.push("ev", []).then(
      () => null,
      (e) => e,
    );
    expect(err).not.toBeNull();
    expect(isPeerTimeout(err)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("exportSnapshot uses the transfer timeout", async () => {
    const p = httpLeasePeer(baseUrl, "s", { callTimeoutMs: 60_000, transferTimeoutMs: 200 });
    const started = Date.now();
    await expect(p.exportSnapshot("ev")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a normal reply resolves", async () => {
    mode = "json";
    const t = httpPeerTransport(baseUrl, "s", { callTimeoutMs: 2000 });
    await expect(t.push("ev", [])).resolves.toEqual({ synced: [], failed: [] });
  });
});
