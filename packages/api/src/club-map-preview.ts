import type { FastifyInstance } from "fastify";
import { prisma } from "./db.js";
import { assertClubRestAccess } from "./restGuard.js";

/**
 * Render an OCAD buffer as a small PNG. Preview failures are deliberately
 * non-fatal: club-map uploads must retain the same permissive behaviour as
 * metadata parsing, including for old or malformed files.
 */
export async function renderOcadPreview(
  buffer: Buffer,
  maxWidth = 512,
): Promise<Buffer | null> {
  try {
    const ocadMod = await import("ocad2geojson");
    const readOcad = (ocadMod as Record<string, unknown>).readOcad as (
      buf: Buffer,
      opts?: Record<string, unknown>,
    ) => Promise<unknown>;
    const ocadToSvg = (ocadMod as Record<string, unknown>).ocadToSvg as (
      file: unknown,
      opts: Record<string, unknown>,
    ) => { outerHTML: string };

    const jsdomMod = await import("jsdom");
    const dom = new jsdomMod.JSDOM("<!DOCTYPE html><html><body></body></html>");
    const ocadFile = await readOcad(buffer, { quietWarnings: true });
    const svg = ocadToSvg(ocadFile, {
      document: dom.window.document,
      generateSymbolElements: true,
      exportHidden: false,
    });

    const { Resvg } = await import("@resvg/resvg-js");
    return Buffer.from(
      new Resvg(svg.outerHTML, {
        fitTo: { mode: "width", value: maxWidth },
        background: "white",
      })
        .render()
        .asPng(),
    );
  } catch (err) {
    console.warn("[club-map-preview] Failed to render OCAD preview:", err);
    return null;
  }
}

/** Return a stored preview, lazily generating and persisting legacy rows. */
export async function getOrCreateClubMapPreview(
  id: bigint,
): Promise<Buffer | null> {
  const existing = await prisma().clubMapFile.findUnique({
    where: { id },
    select: { previewPng: true },
  });
  if (!existing) return null;
  if (existing.previewPng) return Buffer.from(existing.previewPng);

  // Load the OCAD blob only when a preview still needs to be rendered.
  const row = await prisma().clubMapFile.findUnique({
    where: { id },
    select: { fileData: true },
  });
  if (!row) return null;

  const preview = await renderOcadPreview(Buffer.from(row.fileData));
  if (!preview) return null;
  await prisma().clubMapFile.update({
    where: { id },
    data: { previewPng: Uint8Array.from(preview) },
  });
  return preview;
}

export function registerClubMapPreviewRoute(server: FastifyInstance): void {
  server.get<{ Params: { id: string } }>(
    "/api/club-map-preview/:id",
    async (req, reply) => {
      if (!(await assertClubRestAccess(req, reply))) return;

      let id: bigint;
      try {
        id = BigInt(req.params.id);
      } catch {
        return reply.code(400).send({ error: "Invalid club map id" });
      }
      if (id <= 0n) {
        return reply.code(400).send({ error: "Invalid club map id" });
      }

      const preview = await getOrCreateClubMapPreview(id);
      if (!preview) {
        return reply.code(404).send({ error: "No preview" });
      }
      return reply
        .header("Content-Type", "image/png")
        .header("Cache-Control", "private, max-age=3600")
        .send(preview);
    },
  );
}
