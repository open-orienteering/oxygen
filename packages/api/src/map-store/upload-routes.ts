/**
 * Chunked map upload routes (docs/map-storage.md §5; research 07 §7).
 *
 *   POST /api/map-uploads                      { fileName, bytes, chunkBytes } → 201 { uploadId, chunkCount, chunkBytes }
 *   PUT  /api/map-uploads/:id/chunks/:n        application/octet-stream        → 204
 *   POST /api/map-uploads/:id/finalise                                          → 200 { fileHash, bytes, deduplicated }
 *
 * Chunks go straight into `map_upload_chunks`, so any API instance can
 * take any chunk in any order and no request exceeds Cloud Run's 32 MiB
 * HTTP/1 ceiling. Finalise assembles them through SHA-256 into one
 * content-addressed `map_sources` row (or finds it already there) and
 * drops the staging rows. The event scope comes from `x-event-id` on the
 * init call and is remembered on the upload; club-library uploads have
 * none and need a signed-in user.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { prisma, resolveEvent } from "../db.js";
import { resolveEventCapabilities } from "../permissions.js";
import { identity, type RequestIdentity } from "./routes.js";
import {
  assembleChunks,
  CHUNK_BODY_LIMIT,
  chunkCount,
  expectedChunkSize,
  IMPORTABLE_KINDS,
  missingChunks,
  sniffMapKind,
  validateUploadInit,
} from "./uploads.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type UploadScope = { eventId: bigint; eventDate: Date } | null;
type Access = { ok: true } | { ok: false; status: 401 | 403 | 404; error: string };

/**
 * Event uploads need `courses.edit` on that event; club-library uploads
 * (no event) need a signed-in user, mirroring `clubMap.upload`.
 */
async function authoriseUploadScope(who: RequestIdentity, scope: UploadScope): Promise<Access> {
  if (!who.authEnabled) return { ok: true };
  if (!who.user) return { ok: false, status: 401, error: "Not authenticated" };
  if (scope) {
    const caps = await resolveEventCapabilities({ db: prisma(), eventId: scope.eventId, eventDate: scope.eventDate, user: who.user, authEnabled: true });
    if (!caps.has("courses.edit")) return { ok: false, status: 403, error: "Forbidden" };
  }
  return { ok: true };
}

async function scopeFromHeader(who: RequestIdentity): Promise<UploadScope | { error: 404 }> {
  if (!who.eventNameId) return null;
  const event = await resolveEvent(who.eventNameId);
  if (!event) return { error: 404 };
  return { eventId: event.id, eventDate: event.date ?? new Date(0) };
}

async function scopeFromUpload(eventId: bigint | null): Promise<UploadScope> {
  if (eventId === null) return null;
  const event = await prisma().event.findUnique({ where: { id: eventId }, select: { date: true } });
  return { eventId, eventDate: event?.date ?? new Date(0) };
}

function fail(reply: FastifyReply, status: number, error: string, extra: Record<string, unknown> = {}): FastifyReply {
  return reply.code(status).send({ error, ...extra });
}

export function registerMapUploadRoutes(server: FastifyInstance): void {
  server.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  server.post<{ Body: unknown }>("/api/map-uploads", async (req, reply) => {
    const who = await identity(req);
    const scope = await scopeFromHeader(who);
    if (scope && "error" in scope) return fail(reply, 404, "Unknown event");
    const access = await authoriseUploadScope(who, scope);
    if (!access.ok) return fail(reply, access.status, access.error);

    const check = validateUploadInit(req.body as Parameters<typeof validateUploadInit>[0]);
    if (!check.ok) return fail(reply, check.status, check.error);
    const body = req.body as { fileName: string; bytes: number; chunkBytes: number };
    const row = await prisma().mapUpload.create({
      data: {
        eventId: scope?.eventId ?? null,
        fileName: body.fileName.trim(),
        declaredBytes: body.bytes,
        chunkBytes: body.chunkBytes,
        uploadedBy: who.user?.id ?? null,
      },
      select: { id: true },
    });
    return reply.code(201).send({ uploadId: row.id, chunkCount: check.chunkCount, chunkBytes: body.chunkBytes });
  });

  server.put<{ Params: { id: string; n: string }; Body: Buffer }>(
    "/api/map-uploads/:id/chunks/:n",
    { bodyLimit: CHUNK_BODY_LIMIT },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return fail(reply, 404, "Unknown upload");
      const upload = await prisma().mapUpload.findUnique({
        where: { id: req.params.id },
        select: { id: true, eventId: true, declaredBytes: true, chunkBytes: true, kind: true, finalisedHash: true, uploadedBy: true },
      });
      if (!upload) return fail(reply, 404, "Unknown upload");
      const who = await identity(req);
      const access = await authoriseUploadScope(who, await scopeFromUpload(upload.eventId));
      if (!access.ok) return fail(reply, access.status, access.error);
      if (upload.finalisedHash) return fail(reply, 409, "Upload already finalised");

      const n = Number(req.params.n);
      const expected = expectedChunkSize(n, upload.declaredBytes, upload.chunkBytes);
      if (expected === null) return fail(reply, 400, `Chunk index out of range (0..${chunkCount(upload.declaredBytes, upload.chunkBytes) - 1})`);
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (body.byteLength !== expected) return fail(reply, 400, `Chunk ${n} must be ${expected} bytes, got ${body.byteLength}`);

      let kind = upload.kind;
      if (n === 0) {
        const sniffed = sniffMapKind(body);
        if (!sniffed || !IMPORTABLE_KINDS.has(sniffed)) {
          return fail(reply, 415, sniffed ? `${sniffed} files cannot be imported yet` : "Not an OCAD or Mapper file");
        }
        kind = sniffed;
      }
      await prisma().$transaction([
        prisma().mapUploadChunk.upsert({
          where: { uploadId_n: { uploadId: upload.id, n } },
          create: { uploadId: upload.id, n, bytes: Uint8Array.from(body) },
          update: { bytes: Uint8Array.from(body) },
        }),
        ...(kind !== upload.kind ? [prisma().mapUpload.update({ where: { id: upload.id }, data: { kind } })] : []),
      ]);
      return reply.code(204).send();
    },
  );

  server.post<{ Params: { id: string } }>("/api/map-uploads/:id/finalise", async (req, reply) => {
    if (!UUID.test(req.params.id)) return fail(reply, 404, "Unknown upload");
    const upload = await prisma().mapUpload.findUnique({
      where: { id: req.params.id },
      select: { id: true, eventId: true, fileName: true, declaredBytes: true, chunkBytes: true, kind: true, finalisedHash: true, uploadedBy: true },
    });
    if (!upload) return fail(reply, 404, "Unknown upload");
    const who = await identity(req);
    const access = await authoriseUploadScope(who, await scopeFromUpload(upload.eventId));
    if (!access.ok) return fail(reply, access.status, access.error);
    if (upload.finalisedHash) {
      // Idempotent: a retried finalise answers like the first one.
      return reply.code(200).send({ fileHash: upload.finalisedHash, bytes: upload.declaredBytes, deduplicated: true });
    }

    const count = chunkCount(upload.declaredBytes, upload.chunkBytes);
    const present = await prisma().mapUploadChunk.findMany({ where: { uploadId: upload.id }, select: { n: true } });
    const missing = missingChunks(count, present.map((c) => c.n));
    if (missing.length > 0) return fail(reply, 409, "Upload incomplete", { missing });
    if (!upload.kind) return fail(reply, 415, "Not an OCAD or Mapper file");

    // Chunks are at most 8 MiB and a file at most 128 MiB, so assembling in
    // memory is bounded; one bytea insert needs the whole value anyway.
    const ordered: Uint8Array[] = [];
    for (let n = 0; n < count; n++) {
      const chunk = await prisma().mapUploadChunk.findUnique({ where: { uploadId_n: { uploadId: upload.id, n } }, select: { bytes: true } });
      if (!chunk) return fail(reply, 409, "Upload incomplete", { missing: [n] });
      ordered.push(chunk.bytes);
    }
    const { bytes, fileHash } = assembleChunks(ordered);
    if (bytes.byteLength !== upload.declaredBytes) return fail(reply, 400, `Assembled ${bytes.byteLength} bytes, declared ${upload.declaredBytes}`);

    const inserted = await prisma().mapSource.createMany({
      data: [{ fileHash, kind: upload.kind, bytes: Uint8Array.from(bytes), sizeBytes: bytes.byteLength, fileName: upload.fileName, uploadedBy: upload.uploadedBy }],
      skipDuplicates: true,
    });
    await prisma().$transaction([
      prisma().mapUpload.update({ where: { id: upload.id }, data: { finalisedHash: fileHash } }),
      prisma().mapUploadChunk.deleteMany({ where: { uploadId: upload.id } }),
    ]);
    return reply.code(200).send({ fileHash, bytes: bytes.byteLength, deduplicated: inserted.count === 0 });
  });
}
