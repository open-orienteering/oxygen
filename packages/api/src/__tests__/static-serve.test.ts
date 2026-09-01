/**
 * Unit tests for the cloud single-container static serving module
 * (staticServe.ts). Mirrors the behavior of docker/nginx.conf: SPA
 * fallback to index.html for non-API GET routes, aggressive caching for
 * hashed /assets, no-cache for index.html, and /trpc + /api passthrough.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerStaticServe } from "../staticServe.js";

const INDEX_HTML = "<!doctype html><title>oxygen</title>";
const ASSET_JS = "console.log('hashed asset');";

describe("registerStaticServe", () => {
  let distDir: string;
  let server: FastifyInstance;

  beforeAll(async () => {
    distDir = await mkdtemp(path.join(tmpdir(), "oxygen-web-dist-"));
    await writeFile(path.join(distDir, "index.html"), INDEX_HTML);
    await mkdir(path.join(distDir, "assets"));
    await writeFile(path.join(distDir, "assets", "app-abc123.js"), ASSET_JS);

    server = Fastify();
    // Stand-ins for the real API surface registered in index.ts.
    server.get("/trpc/ping", async () => ({ pong: true }));
    server.get("/api/version", async () => ({ startedAt: "test" }));
    await registerStaticServe(server, distDir);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await rm(distDir, { recursive: true, force: true });
  });

  it("serves index.html at / with no-cache headers", async () => {
    const res = await server.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX_HTML);
    expect(res.headers["cache-control"]).toContain("no-store");
  });

  it("serves hashed assets with immutable long-lived cache headers", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/assets/app-abc123.js",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(ASSET_JS);
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("falls back to index.html for SPA routes", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/events/itest/runners/5",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX_HTML);
    expect(res.headers["cache-control"]).toContain("no-store");
  });

  it("does not intercept /trpc routes", async () => {
    const res = await server.inject({ method: "GET", url: "/trpc/ping" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pong: true });
  });

  it("does not intercept /api routes", async () => {
    const res = await server.inject({ method: "GET", url: "/api/version" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ startedAt: "test" });
  });

  it("returns 404 (not index.html) for unknown /trpc and /api paths", async () => {
    const trpc = await server.inject({ method: "GET", url: "/trpc/nope" });
    expect(trpc.statusCode).toBe(404);
    const api = await server.inject({ method: "GET", url: "/api/nope" });
    expect(api.statusCode).toBe(404);
  });

  it("returns 404 for non-GET requests to unknown routes", async () => {
    const res = await server.inject({ method: "POST", url: "/events/itest" });
    expect(res.statusCode).toBe(404);
  });
});
