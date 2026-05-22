/**
 * Server-side proxy for Livelox map tile URLs.
 *
 * The Livelox CDN serves tiles from rotating Azure Blob Storage URLs
 * that the browser cannot fetch directly because they don't set
 * permissive CORS headers. The `transformToReplayData` step in
 * `src/livelox/transform.ts` rewrites every tile URL to
 * `/api/livelox-tile?url=<encoded original URL>`, and this proxy
 * fetches the byte stream server-side and streams it back to the
 * browser with a long cache-control so the browser stops hammering us
 * on every pan / zoom.
 *
 * Allow-list: only URLs whose host ends in `.livelox.com` or
 * `core.windows.net` are proxied. Anything else returns 400 — this
 * keeps the endpoint from being abused as an open proxy.
 */

import type { FastifyInstance } from "fastify";

const ALLOWED_HOST_SUFFIXES = [
  ".livelox.com",
  ".core.windows.net",
];

function isAllowed(target: URL): boolean {
  const host = target.hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export function registerLiveloxTileProxy(server: FastifyInstance): void {
  server.get<{ Querystring: { url?: string } }>(
    "/api/livelox-tile",
    async (req, reply) => {
      const raw = req.query.url;
      if (!raw || typeof raw !== "string") {
        return reply.code(400).send({ error: "missing url" });
      }

      let target: URL;
      try {
        target = new URL(raw);
      } catch {
        return reply.code(400).send({ error: "invalid url" });
      }

      if (target.protocol !== "https:" && target.protocol !== "http:") {
        return reply.code(400).send({ error: "unsupported scheme" });
      }
      if (!isAllowed(target)) {
        return reply.code(400).send({ error: "host not allowed" });
      }

      try {
        const upstream = await fetch(target.toString(), {
          // Forward nothing — Livelox tiles are public and we don't
          // want to leak the client's identity.
          method: "GET",
        });
        if (!upstream.ok) {
          return reply
            .code(upstream.status)
            .send({ error: `upstream ${upstream.status}` });
        }
        const contentType =
          upstream.headers.get("content-type") ?? "application/octet-stream";
        const bytes = Buffer.from(await upstream.arrayBuffer());
        return reply
          .header("Content-Type", contentType)
          // Map tiles are immutable once a class is published — a long
          // browser-cache TTL is the whole reason we proxy at all.
          .header("Cache-Control", "public, max-age=604800, immutable")
          .send(bytes);
      } catch (err) {
        server.log.warn({ err, url: raw }, "livelox tile proxy upstream error");
        return reply.code(502).send({ error: "upstream fetch failed" });
      }
    },
  );
}
