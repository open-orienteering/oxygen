/**
 * `GET /api/map-documents/:hash` (docs/map-storage.md §4).
 *
 * Immutable by construction: the URL is the content hash, so the response
 * carries `private, max-age=1y, immutable` and an `ETag` equal to the
 * hash. Single-range requests are served with `206` from a TOAST slice.
 * Compression is negotiated per request and switched off for ranges
 * (`Content-Encoding` and `Content-Range` do not compose).
 *
 * The hash is not enumerable but it is not authorisation either: the
 * request must come with a principal that may see a reference to the
 * document — an event capability or kiosk key via `x-event-id` /
 * `?event=`, or a signed-in user for a club-library version.
 */

import { brotliCompressSync, constants as zlib, gzipSync } from "node:zlib";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Capability } from "@oxygen/shared";
import { authDevEmail, authHeaderName, authMode, parseIdentityEmail, resolveUser, type AuthUser } from "../auth.js";
import { prisma, resolveEvent } from "../db.js";
import { resolveEventCapabilities } from "../permissions.js";
import { kioskKeyMatches, KIOSK_KEY_HEADER } from "../trpc.js";
import { getBlob, getBlobSize } from "./blob-store.js";

export const MAP_DOCUMENT_CONTENT_TYPE = "application/vnd.oxygen.map";
export const MAP_DOCUMENT_CACHE_CONTROL = "private, max-age=31536000, immutable";
const HASH = /^[0-9a-f]{64}$/;
const VIEW_CAP: Capability = "courses.view";
/** Below this size compression costs more than it saves on the wire. */
const COMPRESS_MIN_BYTES = 1024;

// ---- range ------------------------------------------------------------------

export type RangeParse = { kind: "none" } | { kind: "range"; start: number; end: number } | { kind: "unsatisfiable" } | { kind: "ignored" };

/**
 * RFC 9110 single byte range against a known size. Multiple ranges and
 * other units are ignored (full response), a range past the end is
 * unsatisfiable (416).
 */
export function parseRangeHeader(header: string | undefined, size: number): RangeParse {
  if (!header) return { kind: "none" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return { kind: "ignored" };
  const [, a, b] = m;
  if (a === "" && b === "") return { kind: "ignored" };
  if (size === 0) return { kind: "unsatisfiable" };
  let start: number, end: number;
  if (a === "") {
    // suffix range: last N bytes
    const n = Number(b);
    if (n === 0) return { kind: "unsatisfiable" };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return { kind: "unsatisfiable" };
  return { kind: "range", start, end };
}

// ---- compression ------------------------------------------------------------

export type Encoding = "br" | "gzip" | null;

/** Pick brotli, then gzip, from `Accept-Encoding`; identity otherwise. */
export function negotiateEncoding(acceptEncoding: string | undefined): Encoding {
  if (!acceptEncoding) return null;
  const accepted = new Map<string, number>();
  for (const part of acceptEncoding.split(",")) {
    const [name, ...params] = part.trim().split(";");
    let q = 1;
    for (const p of params) {
      const [k, v] = p.trim().split("=");
      if (k === "q") q = Number(v);
    }
    if (name) accepted.set(name.toLowerCase(), Number.isFinite(q) ? q : 0);
  }
  const ok = (n: string) => (accepted.get(n) ?? accepted.get("*") ?? 0) > 0;
  if (ok("br")) return "br";
  if (ok("gzip")) return "gzip";
  return null;
}

function compress(bytes: Buffer, enc: Exclude<Encoding, null>): Buffer {
  return enc === "br"
    ? brotliCompressSync(bytes, { params: { [zlib.BROTLI_PARAM_QUALITY]: 5, [zlib.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength } })
    : gzipSync(bytes, { level: 6 });
}

// ---- authorisation ----------------------------------------------------------

export interface DocumentAccessInput {
  hash: string;
  authEnabled: boolean;
  user: AuthUser | null;
  kioskKey: string | null;
  /** Event the caller claims the document through (`x-event-id` / `?event=`). */
  eventNameId: string | null;
}

export interface DocumentAccessQueries {
  eventPinsDocument: (eventNameId: string, hash: string) => Promise<{ eventId: bigint; eventDate: Date; kioskKey: string | null } | null>;
  userHasCapability: (eventId: bigint, eventDate: Date, user: AuthUser, cap: Capability) => Promise<boolean>;
  clubVersionHasDocument: (hash: string) => Promise<boolean>;
}

export type DocumentAccess = { ok: true } | { ok: false; status: 401 | 403 };

/**
 * The predicate (docs/map-storage.md §4.2), pure over the three queries
 * so it can be unit-tested; the route binds them to Prisma.
 */
export async function authoriseDocumentAccess(input: DocumentAccessInput, q: DocumentAccessQueries): Promise<DocumentAccess> {
  if (!input.authEnabled) return { ok: true };
  if (input.eventNameId) {
    const pin = await q.eventPinsDocument(input.eventNameId, input.hash);
    if (pin) {
      if (kioskKeyMatches(input.kioskKey, pin.kioskKey)) return { ok: true };
      if (input.user && (await q.userHasCapability(pin.eventId, pin.eventDate, input.user, VIEW_CAP))) return { ok: true };
    }
  }
  if (input.user && (await q.clubVersionHasDocument(input.hash))) return { ok: true };
  return { ok: false, status: input.user ? 403 : 401 };
}

const prismaQueries: DocumentAccessQueries = {
  async eventPinsDocument(eventNameId, hash) {
    const event = await resolveEvent(eventNameId);
    if (!event) return null;
    const pinned = await prisma().mapFile.findFirst({ where: { eventId: event.id, documentHash: hash }, select: { id: true } });
    return pinned ? { eventId: event.id, eventDate: event.date ?? new Date(0), kioskKey: event.kioskKey ?? null } : null;
  },
  async userHasCapability(eventId, eventDate, user, cap) {
    const caps = await resolveEventCapabilities({ db: prisma(), eventId, eventDate, user, authEnabled: true });
    return caps.has(cap);
  },
  async clubVersionHasDocument(hash) {
    const v = await prisma().clubMapVersion.findFirst({ where: { documentHash: hash }, select: { id: true } });
    return v !== null;
  },
};

/** Positive decisions are cached per (hash, principal, event) for a minute. */
const ACCESS_TTL_MS = 60_000;
const accessCache = new Map<string, number>();
function cacheKey(i: DocumentAccessInput): string {
  return `${i.hash}|${i.user?.id ?? ""}|${i.kioskKey ?? ""}|${i.eventNameId ?? ""}`;
}
export function resetDocumentAccessCache(): void {
  accessCache.clear();
}

export type RequestIdentity = Omit<DocumentAccessInput, "hash">;

/** Who is calling a REST map route: user per AUTH_MODE, kiosk key, event (header or `?event=`). */
export async function identity(req: FastifyRequest): Promise<RequestIdentity> {
  const mode = authMode();
  const q = (req.query ?? {}) as Record<string, string | undefined>;
  const header = (name: string) => {
    const v = req.headers[name];
    return (Array.isArray(v) ? v[0] : v)?.trim() || null;
  };
  let user: AuthUser | null = null;
  if (mode === "proxy") {
    const email = parseIdentityEmail(req.headers[authHeaderName()]);
    if (email) user = await resolveUser(email);
  } else if (mode === "dev") {
    user = await resolveUser(parseIdentityEmail(authDevEmail()) ?? "dev@localhost", { implicitAdmin: true });
  }
  return {
    authEnabled: mode !== "off",
    user,
    kioskKey: header(KIOSK_KEY_HEADER) ?? (q.k?.trim() || null),
    eventNameId: header("x-event-id") ?? header("x-competition-id") ?? (q.event?.trim() || null),
  };
}

/** Lower-cased `:hash` when it is 64 hex digits, else `null`. */
export function parseDocumentHash(raw: string): string | null {
  const hash = raw.toLowerCase();
  return HASH.test(hash) ? hash : null;
}

/**
 * §4.2 for one request: the predicate behind the 60 s positive cache.
 * Sends 401/403 and returns false when the caller may not see `hash`.
 * Shared by the document route and the preview routes (§4.4).
 */
export async function requireDocumentAccess(req: FastifyRequest, reply: FastifyReply, hash: string): Promise<boolean> {
  const who = await identity(req);
  const input: DocumentAccessInput = { hash, ...who };
  const key = cacheKey(input);
  const cachedUntil = accessCache.get(key);
  if (cachedUntil !== undefined && cachedUntil > Date.now()) return true;
  const access = await authoriseDocumentAccess(input, prismaQueries);
  if (!access.ok) {
    void reply.code(access.status).send({ error: access.status === 401 ? "Not authenticated" : "Forbidden" });
    return false;
  }
  accessCache.set(key, Date.now() + ACCESS_TTL_MS);
  return true;
}

// ---- route ------------------------------------------------------------------

export function registerMapDocumentRoutes(server: FastifyInstance): void {
  server.get<{ Params: { hash: string } }>("/api/map-documents/:hash", async (req, reply) => {
    const hash = parseDocumentHash(req.params.hash);
    if (!hash) return reply.code(400).send({ error: "Invalid document hash" });
    if (!(await requireDocumentAccess(req, reply, hash))) return reply;

    const size = await getBlobSize(prisma(), "map_documents", hash);
    if (size === null) return reply.code(404).send({ error: "Unknown document" });

    const etag = `"${hash}"`;
    void reply
      .header("Content-Type", MAP_DOCUMENT_CONTENT_TYPE)
      .header("Cache-Control", MAP_DOCUMENT_CACHE_CONTROL)
      .header("ETag", etag)
      .header("Accept-Ranges", "bytes")
      .header("Vary", "Accept-Encoding");

    if (matchesEtag(req.headers["if-none-match"], etag)) return reply.code(304).send();

    const range = parseRangeHeader(req.headers.range, size);
    if (range.kind === "unsatisfiable") return reply.code(416).header("Content-Range", `bytes */${size}`).send();
    if (range.kind === "range") {
      const chunk = await getBlob(prisma(), "map_documents", hash, range);
      if (!chunk) return reply.code(404).send({ error: "Unknown document" });
      return reply
        .code(206)
        .header("Content-Range", `bytes ${range.start}-${range.end}/${size}`)
        .header("Content-Length", String(chunk.byteLength))
        .send(chunk);
    }

    const bytes = await getBlob(prisma(), "map_documents", hash);
    if (!bytes) return reply.code(404).send({ error: "Unknown document" });
    return sendWhole(reply, bytes, negotiateEncoding(req.headers["accept-encoding"]));
  });
}

function sendWhole(reply: FastifyReply, bytes: Buffer, enc: Encoding): FastifyReply {
  if (enc && bytes.byteLength >= COMPRESS_MIN_BYTES) {
    const body = compress(bytes, enc);
    return reply.header("Content-Encoding", enc).header("Content-Length", String(body.byteLength)).send(body);
  }
  return reply.header("Content-Length", String(bytes.byteLength)).send(bytes);
}

/** `If-None-Match` against one ETag: weak or strong, a list, or `*`. */
export function matchesEtag(ifNoneMatch: string | string[] | undefined, etag: string): boolean {
  const raw = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(",") : ifNoneMatch;
  if (!raw) return false;
  return raw.split(",").some((t) => {
    const v = t.trim().replace(/^W\//, "");
    return v === "*" || v === etag;
  });
}
