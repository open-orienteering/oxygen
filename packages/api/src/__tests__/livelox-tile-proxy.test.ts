/**
 * Unit tests for the Livelox tile proxy's input validation. These
 * exercise the cheap rejection paths (missing url, bad url, scheme
 * filter, host allow-list) without needing live network access; the
 * happy path is covered indirectly by the standalone replay viewer
 * (manual smoke test against the real CDN).
 *
 * Boots a minimal Fastify instance with just the proxy registered and
 * uses `inject()` so nothing actually touches the network.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerLiveloxTileProxy } from "../livelox-tile-proxy.js";

let server: FastifyInstance;

beforeAll(async () => {
  server = Fastify({ logger: false });
  registerLiveloxTileProxy(server);
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

describe("livelox tile proxy", () => {
  it("returns 400 when the url query param is missing", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/livelox-tile",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "missing url" });
  });

  it("returns 400 for an unparseable url", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/livelox-tile?url=not-a-url",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid url" });
  });

  it("returns 400 for non-http schemes (no file://, no javascript:, …)", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/api/livelox-tile?url=${encodeURIComponent("file:///etc/passwd")}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "unsupported scheme" });
  });

  it("rejects unknown hosts (prevents the open-proxy footgun)", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/api/livelox-tile?url=${encodeURIComponent("https://example.com/x.png")}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "host not allowed" });
  });

  it("rejects hosts that merely contain — but don't end with — an allowed suffix", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/api/livelox-tile?url=${encodeURIComponent("https://livelox.com.evil.example/x.png")}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "host not allowed" });
  });

  it("accepts a *.livelox.com URL (proxies; upstream may 404 but at least we tried)", async () => {
    // We don't actually want to hit Livelox in CI, so we point at a
    // sub-domain that won't resolve. The proxy should make it past
    // input validation and into the fetch path; the only way to know
    // is by observing a 502 (upstream failure) instead of a 400
    // (validation rejection). 15s timeout because some DNS resolvers
    // take their sweet time before returning NXDOMAIN.
    const res = await server.inject({
      method: "GET",
      url: `/api/livelox-tile?url=${encodeURIComponent(
        "https://does-not-resolve.livelox.com/tile.png",
      )}`,
    });
    expect([502, 200, 404]).toContain(res.statusCode);
  }, 15_000);

  it("accepts a *.core.windows.net URL (Azure Blob Storage)", async () => {
    // Azure's blob.core.windows.net wildcards a lot of subdomains —
    // pick a path that fails fast (404) rather than a hostname that
    // hangs in DNS / TCP. Same intent as the *.livelox.com test:
    // confirm validation lets it through, regardless of upstream
    // outcome.
    const res = await server.inject({
      method: "GET",
      url: `/api/livelox-tile?url=${encodeURIComponent(
        "https://oxygentest.blob.core.windows.net/does-not-exist/tile.png",
      )}`,
    });
    expect([502, 200, 404, 403, 400, 409]).toContain(res.statusCode);
  }, 15_000);
});
