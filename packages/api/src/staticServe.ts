/**
 * Single-container static serving for the cloud deployment.
 *
 * The Docker `cloud` target (Cloud Run) has no nginx in front of the API,
 * so when `WEB_DIST_DIR` points at the built web bundle the API serves it
 * itself, replicating docker/nginx.conf:
 *
 *   - hashed `/assets` are immutable and cached for a year;
 *   - `index.html` is never cached, so a deploy invalidates instantly;
 *   - unknown GET routes fall back to `index.html` (SPA routing);
 *   - `/trpc` and `/api` are never intercepted — unknown paths there
 *     stay honest 404s for programmatic clients.
 *
 * Deployments with a separate web container (docker-compose) leave
 * `WEB_DIST_DIR` unset and this module is never registered.
 */

import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";

const NO_CACHE = "no-cache, no-store, must-revalidate";
const IMMUTABLE = "public, max-age=31536000, immutable";

export async function registerStaticServe(
  server: FastifyInstance,
  distDir: string,
): Promise<void> {
  const root = path.resolve(distDir);

  await server.register(fastifyStatic, {
    root,
    // The SPA fallback below owns unmatched routes; a wildcard would
    // shadow it and turn missing files into raw 404s.
    wildcard: false,
    setHeaders(reply, filePath) {
      void reply.header(
        "cache-control",
        filePath.includes(`${path.sep}assets${path.sep}`) ? IMMUTABLE : NO_CACHE,
      );
    },
  });

  server.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? "";
    const isApiPath = url.startsWith("/trpc") || url.startsWith("/api");
    if ((req.method === "GET" || req.method === "HEAD") && !isApiPath) {
      return reply.header("cache-control", NO_CACHE).sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not found" });
  });
}
