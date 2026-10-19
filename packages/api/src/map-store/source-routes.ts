/**
 * `GET /api/map-sources/:hash` (docs/map-storage.md §4.4).
 *
 * The original file as uploaded. It is the club's map, not a rendered
 * view, so it follows the download rules of `course.downloadMap` and
 * `clubMap.download` — never the kiosk key, never cached — rather than
 * the document predicate. Sources reach tens of MB, above Cloud Run's
 * 32 MiB non-streamed response ceiling, so the body is streamed in
 * fixed TOAST slices and the API never holds the whole file (07 §6.4).
 */

import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { Capability } from "@oxygen/shared";
import type { AuthUser } from "../auth.js";
import { prisma, resolveEvent } from "../db.js";
import { canDownloadClubLibraryMap, canDownloadEventMap } from "../ocad-export.js";
import { resolveEventCapabilities } from "../permissions.js";
import { getBlob, type BlobRange, type BlobTable } from "./blob-store.js";
import { identity, type DocumentAccessInput } from "./routes.js";
import type { PrismaClient } from "../generated/prisma/client.js";

export const SOURCE_SLICE_BYTES = 4 * 1024 * 1024;
export const MAP_SOURCE_CACHE_CONTROL = "private, no-store";
const HASH = /^[0-9a-f]{64}$/;
const MANAGE_CAP: Capability = "event.manage";

// ---- pure helpers -----------------------------------------------------------

/** Inclusive byte ranges of at most `sliceBytes` covering `size` bytes. */
export function sliceRanges(size: number, sliceBytes: number): BlobRange[] {
  if (!(sliceBytes > 0)) throw new Error(`slice size must be positive, got ${sliceBytes}`);
  const out: BlobRange[] = [];
  for (let start = 0; start < size; start += sliceBytes) out.push({ start, end: Math.min(start + sliceBytes, size) - 1 });
  return out;
}

/** `attachment` with a quoted ASCII fallback and the RFC 5987 UTF-8 name. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const utf8 = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

// ---- authorisation ----------------------------------------------------------

export interface SourceAccessQueries {
  /** The event's map row carrying this source, if any. */
  eventPinsSource: (eventNameId: string, hash: string) => Promise<{ eventId: bigint; eventDate: Date; fileName: string; fromClubLibrary: boolean } | null>;
  userHasCapability: (eventId: bigint, eventDate: Date, user: AuthUser, cap: Capability) => Promise<boolean>;
  /** `uploaded_by` of every club map version with this `source_hash` (empty when none). */
  clubVersionUploaders: (hash: string) => Promise<Array<string | null>>;
}

/** `fileName` is the event's name for the file when access came through the event, else null (use the source row's). */
export type SourceAccess = { ok: true; fileName: string | null } | { ok: false; status: 401 | 403 };

/**
 * The §4.4 predicate, pure over the queries: `canDownloadEventMap` for an
 * event manager (club-library copies stay with instance admins), and
 * `canDownloadClubLibraryMap` for a club version's source. The kiosk key
 * is ignored.
 */
export async function authoriseSourceAccess(input: DocumentAccessInput, q: SourceAccessQueries): Promise<SourceAccess> {
  if (!input.authEnabled) return { ok: true, fileName: null };
  const user = input.user;
  if (!user) return { ok: false, status: 401 };
  if (input.eventNameId) {
    const pin = await q.eventPinsSource(input.eventNameId, input.hash);
    if (
      pin &&
      (await q.userHasCapability(pin.eventId, pin.eventDate, user, MANAGE_CAP)) &&
      canDownloadEventMap({ authEnabled: true, isAdmin: user.isAdmin, fromClubLibrary: pin.fromClubLibrary })
    ) {
      return { ok: true, fileName: pin.fileName };
    }
  }
  const uploaders = await q.clubVersionUploaders(input.hash);
  if (uploaders.length > 0 && canDownloadClubLibraryMap({ authEnabled: true, isAdmin: user.isAdmin, isUploader: uploaders.includes(user.id) })) {
    return { ok: true, fileName: null };
  }
  return { ok: false, status: 403 };
}

const prismaQueries: SourceAccessQueries = {
  async eventPinsSource(eventNameId, hash) {
    const event = await resolveEvent(eventNameId);
    if (!event) return null;
    const row = await prisma().mapFile.findFirst({
      where: { eventId: event.id, sourceHash: hash },
      orderBy: { uploadedAt: "desc" },
      select: { fileName: true, fromClubLibrary: true },
    });
    return row ? { eventId: event.id, eventDate: event.date ?? new Date(0), fileName: row.fileName, fromClubLibrary: row.fromClubLibrary } : null;
  },
  async userHasCapability(eventId, eventDate, user, cap) {
    const caps = await resolveEventCapabilities({ db: prisma(), eventId, eventDate, user, authEnabled: true });
    return caps.has(cap);
  },
  async clubVersionUploaders(hash) {
    const rows = await prisma().clubMapVersion.findMany({ where: { sourceHash: hash }, select: { uploadedBy: true } });
    return rows.map((r) => r.uploadedBy);
  },
};

// ---- streaming --------------------------------------------------------------

/**
 * The blob as a stream of `sliceBytes` reads. Each slice is one
 * `substring()` over the covering TOAST chunks; a slice that comes back
 * missing or short (the row vanished mid-stream) errors the stream.
 */
export function streamBlob(db: PrismaClient, table: BlobTable, hash: string, size: number, sliceBytes = SOURCE_SLICE_BYTES): Readable {
  async function* slices(): AsyncGenerator<Buffer> {
    for (const range of sliceRanges(size, sliceBytes)) {
      const chunk = await getBlob(db, table, hash, range);
      if (!chunk || chunk.byteLength !== range.end - range.start + 1) throw new Error(`${table} ${hash} changed while streaming`);
      yield chunk;
    }
  }
  return Readable.from(slices(), { objectMode: false });
}

// ---- route ------------------------------------------------------------------

export function registerMapSourceRoutes(server: FastifyInstance, opts: { sliceBytes?: number } = {}): void {
  server.get<{ Params: { hash: string } }>("/api/map-sources/:hash", async (req, reply) => {
    const hash = req.params.hash.toLowerCase();
    if (!HASH.test(hash)) return reply.code(400).send({ error: "Invalid source hash" });

    const access = await authoriseSourceAccess({ hash, ...(await identity(req)) }, prismaQueries);
    if (!access.ok) return reply.code(access.status).send({ error: access.status === 401 ? "Not authenticated" : "Forbidden" });

    const row = await prisma().mapSource.findUnique({ where: { fileHash: hash }, select: { sizeBytes: true, fileName: true } });
    if (!row) return reply.code(404).send({ error: "Unknown source" });

    return reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Disposition", contentDisposition(access.fileName ?? row.fileName))
      .header("Cache-Control", MAP_SOURCE_CACHE_CONTROL)
      .send(streamBlob(prisma(), "map_sources", hash, row.sizeBytes, opts.sliceBytes));
  });
}
