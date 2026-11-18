/**
 * Preview routes (docs/map-storage.md §4.5):
 *
 *   GET /api/map-documents/:hash/thumbnail.png
 *   GET /api/map-documents/:hash/symbols/:idx.png
 *   GET /api/map-documents/:hash/colour-order/:order.png   (the colour panel's picture, §4.5)
 *   GET /api/map-documents/:hash/colour-order/:order.json  (that order's document, for the compare view, §4.5)
 *   GET /api/library/:libraryId/:version/:code.png
 *
 * Immutable like the document route: the URL names the content (a
 * document hash, or a library version), so 2xx carry a one-year
 * `immutable` cache and an `ETag`. Document previews go through the
 * document route's authorisation (`requireDocumentAccess`) before
 * anything is looked up; the library is public data for any signed-in
 * user.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { symbolLibrary } from "@oxygen/shared";
import { prisma } from "../db.js";
import { assertClubRestAccess } from "../restGuard.js";
import {
  getOrRenderSymbolPreview,
  getOrRenderThumbnail,
  LIBRARY_CODE,
  libraryPreviewEtag,
  libraryPreviewPng,
  parseSymbolIdx,
  previewEtag,
  stripPng,
} from "./previews.js";
import { identity, MAP_DOCUMENT_CACHE_CONTROL, matchesEtag, parseDocumentHash, requireDocumentAccess } from "./routes.js";
import type { ColourOrder } from "./colour-settings.js";
import { COLOUR_PICTURE_KIND, colourOrderDocument, colourPicture, parseColourOrderFile, parsePictureDeviations } from "./colour-pictures.js";

export const LIBRARY_PREVIEW_CACHE_CONTROL = "public, max-age=31536000, immutable";

function sendPng(req: FastifyRequest, reply: FastifyReply, png: Buffer, etag: string, cacheControl: string): FastifyReply {
  void reply.header("Content-Type", "image/png").header("Cache-Control", cacheControl).header("ETag", etag);
  if (matchesEtag(req.headers["if-none-match"], etag)) return reply.code(304).send();
  return reply.header("Content-Length", String(png.byteLength)).send(png);
}

async function colourOrderDocumentRoute(req: FastifyRequest<{ Querystring: { deviations?: string } }>, reply: FastifyReply, hash: string, order: ColourOrder): Promise<FastifyReply> {
  const deviations = parsePictureDeviations(typeof req.query.deviations === "string" ? req.query.deviations : undefined);
  if (deviations === null) return reply.code(400).send({ error: "Invalid deviations" });
  if (!(await requireDocumentAccess(req, reply, hash))) return reply;
  const result = await colourOrderDocument(prisma(), hash, order, { startedBy: (await identity(req)).user?.id ?? null, deviations });
  void reply.header("Cache-Control", "no-store");
  if ("failed" in result) return reply.code(502).send({ error: `No document: ${result.failed}` });
  if ("pending" in result) return reply.code(503).header("Retry-After", "5").send({ error: "The document is being imported; ask again" });
  if ("missing" in result) return reply.code(404).send({ error: "Unknown document" });
  return reply.send({ documentHash: result.documentHash });
}

export function registerMapPreviewRoutes(server: FastifyInstance): void {
  server.get<{ Params: { hash: string } }>("/api/map-documents/:hash/thumbnail.png", async (req, reply) => {
    const hash = parseDocumentHash(req.params.hash);
    if (!hash) return reply.code(400).send({ error: "Invalid document hash" });
    if (!(await requireDocumentAccess(req, reply, hash))) return reply;
    const png = await getOrRenderThumbnail(prisma(), hash);
    if (!png) return reply.code(404).send({ error: "No thumbnail" });
    return sendPng(req, reply, png, previewEtag(hash, "thumbnail", ""), MAP_DOCUMENT_CACHE_CONTROL);
  });

  server.get<{ Params: { hash: string; file: string } }>("/api/map-documents/:hash/symbols/:file", async (req, reply) => {
    const hash = parseDocumentHash(req.params.hash);
    if (!hash) return reply.code(400).send({ error: "Invalid document hash" });
    const raw = stripPng(req.params.file);
    const idx = raw === null ? null : parseSymbolIdx(raw);
    if (idx === null) return reply.code(400).send({ error: "Invalid symbol index" });
    if (!(await requireDocumentAccess(req, reply, hash))) return reply;
    const png = await getOrRenderSymbolPreview(prisma(), hash, idx);
    if (!png) return reply.code(404).send({ error: "No such symbol preview" });
    return sendPng(req, reply, png, previewEtag(hash, "symbol", String(idx)), MAP_DOCUMENT_CACHE_CONTROL);
  });

  // The before / after picture (docs/map-symbols.md §8.7): the other order may need an import, so a slow one is a 503.
  // `?deviations=` (row I7): the map's overrides for a `source` document's IOF picture, part of the picture's key.
  // `.json` (row I8a): the document that order gives — `{ documentHash }`, never cached (an import may change the answer's
  // availability, and the requester's job row is part of it).
  server.get<{ Params: { hash: string; file: string }; Querystring: { deviations?: string } }>("/api/map-documents/:hash/colour-order/:file", async (req, reply) => {
    const hash = parseDocumentHash(req.params.hash);
    if (!hash) return reply.code(400).send({ error: "Invalid document hash" });
    const file = parseColourOrderFile(req.params.file);
    if (file === null) return reply.code(400).send({ error: "Invalid colour order" });
    if (file.format === "json") return colourOrderDocumentRoute(req, reply, hash, file.order);
    const { order } = file;
    const deviations = parsePictureDeviations(typeof req.query.deviations === "string" ? req.query.deviations : undefined);
    if (deviations === null) return reply.code(400).send({ error: "Invalid deviations" });
    if (!(await requireDocumentAccess(req, reply, hash))) return reply;
    const result = await colourPicture(prisma(), hash, order, { startedBy: (await identity(req)).user?.id ?? null, deviations });
    if ("failed" in result) return reply.code(502).send({ error: `No picture: ${result.failed}` });
    if ("pending" in result) return reply.code(503).header("Retry-After", "5").send({ error: "The picture is being drawn; ask again" });
    if ("missing" in result) return reply.code(404).send({ error: "Unknown document" });
    return sendPng(req, reply, result.png, previewEtag(hash, COLOUR_PICTURE_KIND, result.key), MAP_DOCUMENT_CACHE_CONTROL);
  });

  server.get<{ Params: { libraryId: string; version: string; file: string } }>(
    "/api/library/:libraryId/:version/:file",
    async (req, reply) => {
      const { libraryId, version } = req.params;
      const code = stripPng(req.params.file);
      if (!symbolLibrary.isSymbolLibraryId(libraryId)) return reply.code(400).send({ error: "Unknown symbol library" });
      if (code === null || !LIBRARY_CODE.test(code)) return reply.code(400).send({ error: "Invalid symbol code" });
      if (!(await assertClubRestAccess(req, reply))) return reply;
      const png = await libraryPreviewPng(libraryId, version, code);
      if (!png) return reply.code(404).send({ error: "No such library symbol" });
      return sendPng(req, reply, png, libraryPreviewEtag(libraryId, version, code), LIBRARY_PREVIEW_CACHE_CONTROL);
    },
  );
}
