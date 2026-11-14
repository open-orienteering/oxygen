/**
 * `GET /api/map-documents/:hash/height.bin?v=<TERRAIN_VERSION>`
 * (docs/map-storage.md §4.7).
 *
 * Immutable like the document route: the hash and the terrain version
 * name the content, so 2xx carry a one-year `immutable` cache and an
 * `ETag`. Validate, authorise through the document route's predicate
 * (`requireDocumentAccess`, §4.2), then existence — a hash cannot be
 * probed. A missing row is derived while the request waits.
 */

import { promisify } from "node:util";
import { brotliCompress, constants as zlib, gzip } from "node:zlib";
import type { FastifyInstance } from "fastify";
import { TERRAIN_VERSION } from "@oxygen/shared/src/terrain/field/types.js";
import { prisma } from "../db.js";
import { getOrDeriveHeightfield, HEIGHTFIELD_CONTENT_TYPE, heightfieldEtag, parseTerrainVersion } from "./heightfield.js";
import { MAP_DOCUMENT_CACHE_CONTROL, matchesEtag, negotiateEncoding, parseDocumentHash, requireDocumentAccess, type Encoding } from "./routes.js";

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const COMPRESS_MIN_BYTES = 1024;

/** Off the event loop: a field is up to ~8 MB and a synchronous brotli would hold it. */
async function compress(bytes: Buffer, enc: Exclude<Encoding, null>): Promise<Buffer> {
  return enc === "br"
    ? brotliAsync(bytes, { params: { [zlib.BROTLI_PARAM_QUALITY]: 5, [zlib.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength } })
    : gzipAsync(bytes, { level: 6 });
}

export function registerMapHeightfieldRoutes(server: FastifyInstance): void {
  server.get<{ Params: { hash: string }; Querystring: { v?: string } }>("/api/map-documents/:hash/height.bin", async (req, reply) => {
    const hash = parseDocumentHash(req.params.hash);
    if (!hash) return reply.code(400).send({ error: "Invalid document hash" });
    const version = parseTerrainVersion(req.query.v);
    if (version === null) return reply.code(400).send({ error: "Missing or invalid terrain version (?v=)" });
    if (!(await requireDocumentAccess(req, reply, hash))) return reply;

    const exists = await prisma().mapDocument.findUnique({ where: { hash }, select: { hash: true } });
    if (!exists) return reply.code(404).send({ error: "Unknown document" });
    if (version !== TERRAIN_VERSION) return reply.code(404).send({ error: `Terrain version ${version} is not served (current: ${TERRAIN_VERSION})`, reason: "version" });

    const etag = heightfieldEtag(hash, version);
    const headers = () =>
      reply
        .header("Content-Type", HEIGHTFIELD_CONTENT_TYPE)
        .header("Cache-Control", MAP_DOCUMENT_CACHE_CONTROL)
        .header("ETag", etag)
        .header("Vary", "Accept-Encoding");
    // The ETag names immutable content that only a 200 handed out: revalidation needs no row read.
    if (matchesEtag(req.headers["if-none-match"], etag)) return headers().code(304).send();

    const result = await getOrDeriveHeightfield(prisma(), hash);
    switch (result.state) {
      case "missing":
        return reply.code(404).send({ error: "Unknown document" });
      case "none":
        return reply.code(404).send({ error: "The map has no contours", reason: "no-contours" });
      case "over-cap":
        return reply.code(404).send({ error: "The map is over this instance's height-field cap", reason: "over-cap" });
      case "failed":
        return reply.code(503).send({ error: "The height field could not be derived" });
      case "ready":
        break;
    }

    void headers();
    const enc = negotiateEncoding(req.headers["accept-encoding"]);
    if (enc && result.bytes.byteLength >= COMPRESS_MIN_BYTES) {
      const body = await compress(result.bytes, enc);
      return reply.header("Content-Encoding", enc).header("Content-Length", String(body.byteLength)).send(body);
    }
    return reply.header("Content-Length", String(result.bytes.byteLength)).send(result.bytes);
  });
}
