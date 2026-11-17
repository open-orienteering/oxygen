/**
 * `GET /api/map-documents/:hash/height.bin?v=<TERRAIN_VERSION>[&source=…]`
 * (docs/map-storage.md §4.7). Without `source` (or `source=contours`) the
 * contour field, derived on a miss; with a DEM source
 * (`ground.<provider>`, `contours.<provider>`, docs/map-terrain.md §7) the
 * DEM job's row, whose miss queues the job and answers 503.
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
import { DEM_JOB_RULES, enqueueDocumentDem, getDemJob, isDemClaimable, kickDemJobs } from "./dem-jobs.js";
import { demProviderById } from "./dem-registry.js";
import { demSourceProvider, getOrDeriveHeightfield, HEIGHTFIELD_CONTENT_TYPE, HEIGHTFIELD_SOURCE, heightfieldEtag, parseHeightfieldSource, parseTerrainVersion, readHeightfield } from "./heightfield.js";
import { MAP_DOCUMENT_CACHE_CONTROL, matchesEtag, negotiateEncoding, parseDocumentHash, requireDocumentAccess, type Encoding } from "./routes.js";

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const COMPRESS_MIN_BYTES = 1024;
/** A queued or running DEM job: ask again after this. */
export const DEM_PENDING_RETRY_AFTER_S = 15;

/** Off the event loop: a field is up to ~8 MB and a synchronous brotli would hold it. */
async function compress(bytes: Buffer, enc: Exclude<Encoding, null>): Promise<Buffer> {
  return enc === "br"
    ? brotliAsync(bytes, { params: { [zlib.BROTLI_PARAM_QUALITY]: 5, [zlib.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength } })
    : gzipAsync(bytes, { level: 6 });
}

export function registerMapHeightfieldRoutes(server: FastifyInstance): void {
  server.get<{ Params: { hash: string }; Querystring: { v?: string; source?: string } }>("/api/map-documents/:hash/height.bin", async (req, reply) => {
    const hash = parseDocumentHash(req.params.hash);
    if (!hash) return reply.code(400).send({ error: "Invalid document hash" });
    const version = parseTerrainVersion(req.query.v);
    if (version === null) return reply.code(400).send({ error: "Missing or invalid terrain version (?v=)" });
    const source = parseHeightfieldSource(req.query.source);
    if (source === null) return reply.code(400).send({ error: "Invalid height source (?source=)" });
    if (!(await requireDocumentAccess(req, reply, hash))) return reply;

    const exists = await prisma().mapDocument.findUnique({ where: { hash }, select: { hash: true } });
    if (!exists) return reply.code(404).send({ error: "Unknown document" });
    if (version !== TERRAIN_VERSION) return reply.code(404).send({ error: `Terrain version ${version} is not served (current: ${TERRAIN_VERSION})`, reason: "version" });

    const providerId = demSourceProvider(source);
    if (providerId !== null && !demProviderById(providerId)) return reply.code(404).send({ error: `This instance serves no height source ${source}`, reason: "source" });

    const etag = heightfieldEtag(hash, version, source);
    const headers = () =>
      reply
        .header("Content-Type", HEIGHTFIELD_CONTENT_TYPE)
        .header("Cache-Control", MAP_DOCUMENT_CACHE_CONTROL)
        .header("ETag", etag)
        .header("Vary", "Accept-Encoding");
    // The ETag names immutable content that only a 200 handed out: revalidation needs no row read.
    if (matchesEtag(req.headers["if-none-match"], etag)) return headers().code(304).send();

    if (source !== HEIGHTFIELD_SOURCE && providerId !== null) {
      const db = prisma();
      const row = await readHeightfield(db, hash, version, source);
      if (row?.bytes) return send(row.bytes);
      const job = await getDemJob(db, hash, providerId);
      const pending = () => reply.code(503).header("Retry-After", String(DEM_PENDING_RETRY_AFTER_S)).send({ error: "The DEM is being fetched", reason: "pending" });
      if (!job) {
        await enqueueDocumentDem(db, hash, providerId);
        return pending();
      }
      switch (job.state) {
        case "queued":
        case "running":
          if (isDemClaimable({ ...job, heartbeatAt: null }) && job.state === "queued") void kickDemJobs(db);
          return pending();
        case "done":
          // done without its row: the row went (a GC run between versions); fetch again
          await db.mapDemJob.updateMany({ where: { documentHash: hash, provider: providerId, version, state: "done" }, data: { state: "queued", attempts: 0, nextAttemptAt: null } });
          void kickDemJobs(db);
          return pending();
        case "unavailable":
          return reply.code(404).send({ error: "There is no DEM for this map from this source", reason: job.reason });
        case "failed": {
          if (!job.nextAttemptAt) return reply.code(404).send({ error: "Fetching the DEM failed", reason: job.reason });
          const wait = Math.max(DEM_PENDING_RETRY_AFTER_S, Math.ceil((job.nextAttemptAt.getTime() - Date.now()) / 1000));
          return reply.code(503).header("Retry-After", String(Math.min(wait, DEM_JOB_RULES.retryMs[DEM_JOB_RULES.retryMs.length - 1] / 1000))).send({ error: "Fetching the DEM failed; it is retried", reason: job.reason });
        }
      }
    }

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

    return send(result.bytes);

    async function send(bytes: Buffer) {
      void headers();
      const enc = negotiateEncoding(req.headers["accept-encoding"]);
      if (enc && bytes.byteLength >= COMPRESS_MIN_BYTES) {
        const body = await compress(bytes, enc);
        return reply.header("Content-Encoding", enc).header("Content-Length", String(body.byteLength)).send(body);
      }
      return reply.header("Content-Length", String(bytes.byteLength)).send(bytes);
    }
  });
}
