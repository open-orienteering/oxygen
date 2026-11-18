/**
 * The colour panel's before / after picture (docs/map-symbols.md §8.7
 * "Colour layers", docs/map-storage.md §4.5): the reviewed document over a
 * capped window, drawn by the reference raster in the IOF order and in the
 * map's own order. The document's own order is drawn from it; the other
 * order from the document its source imports to in that order — the
 * document the switch would give — found by dedup or imported by an
 * ordinary job without a target on the first request. The PNG is a
 * `map_previews` row of the reviewed document (kind `colour-order`, key the
 * order), written once and never updated.
 */

import { mapDocument } from "@oxygen/shared";
import type { PrismaClient } from "../generated/prisma/client.js";
import { colourPictureWindow, renderColourPicturePng } from "../render/previews.js";
import { getBlob } from "./blob-store.js";
import { colourSettingsOfReport, type ColourOrder } from "./colour-settings.js";
import { awaitImportJob, isTerminal, startImportJob } from "./jobs.js";
import { once, readPreview, serialised, writePreview } from "./previews.js";

export const COLOUR_PICTURE_KIND = "colour-order" as const;
/** How long the route waits for a picture whose other order is still importing before answering 503. */
export const COLOUR_PICTURE_WAIT_MS = Number(process.env.MAP_COLOUR_PICTURE_WAIT_MS ?? 20_000);

export function parseColourOrder(raw: string): ColourOrder | null {
  return raw === "iof" || raw === "source" ? raw : null;
}

export type ColourPictureResult = { png: Buffer } | { pending: true } | { missing: true };

/** The order a stored document is drawn in: its header's (no record: before the layers, the map's own). */
const orderOf = (doc: mapDocument.MapDocument): ColourOrder => doc.header.colourOrder?.order ?? "source";

async function decodeStored(db: PrismaClient, hash: string): Promise<mapDocument.MapDocument | null> {
  const bytes = await getBlob(db, "map_documents", hash);
  return bytes ? mapDocument.decodeMapDocument(bytes) : null;
}

/**
 * Render and store the picture. The other order's import runs before the
 * render queue is entered (its derive stage renders through the same
 * queue). Throws when that import fails.
 */
async function produce(db: PrismaClient, hash: string, order: ColourOrder, startedBy: string | null): Promise<Buffer | null> {
  const row = await db.mapDocument.findUnique({ where: { hash }, select: { sourceHash: true, patch: true, report: true } });
  if (!row) return null;
  const reviewed = await decodeStored(db, hash);
  if (!reviewed) return null;
  let drawn = reviewed;
  if (orderOf(reviewed) !== order) {
    // The document the switch gives: the same corrections and overrides, the other order.
    const colour = { order, deviations: colourSettingsOfReport(row.report).deviations };
    let job = await startImportJob(db, { sourceHash: row.sourceHash, startedBy, patch: mapDocument.parseVersionPatch(row.patch), colour, holdMs: 0 });
    if (!isTerminal(job.state)) job = (await awaitImportJob(db, job.id)) ?? job;
    if (job.state !== "done" || !job.documentHash) throw new Error(`the ${order} import of ${row.sourceHash} ${job.state === "failed" ? `failed: ${job.error ?? ""}` : `is still ${job.state}`}`);
    const other = await decodeStored(db, job.documentHash);
    if (!other) return null;
    drawn = other;
  }
  const png = await serialised(() => renderColourPicturePng(drawn, colourPictureWindow(reviewed)));
  await writePreview(db, hash, COLOUR_PICTURE_KIND, order, png);
  return png;
}

/**
 * The picture of document `hash` in `order`: the stored row, else rendered
 * (and the other order imported) now. Waits up to `waitMs`; past that the
 * work goes on and `{ pending: true }` says to ask again. `{ missing }`
 * when there is no such document.
 */
export async function colourPicture(db: PrismaClient, hash: string, order: ColourOrder, opts: { startedBy: string | null; waitMs?: number }): Promise<ColourPictureResult> {
  const stored = await readPreview(db, hash, COLOUR_PICTURE_KIND, order);
  if (stored) return { png: stored };
  const work = once(`${hash}/${COLOUR_PICTURE_KIND}/${order}`, () => produce(db, hash, order, opts.startedBy));
  // A failure is reported to the request that is waiting; one that comes after the wait is logged.
  work.catch((err: unknown) => console.error(`[map-previews] colour picture ${hash}/${order}:`, err instanceof Error ? err.message : err));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"pending">((resolve) => { timer = setTimeout(() => resolve("pending"), opts.waitMs ?? COLOUR_PICTURE_WAIT_MS); });
  try {
    const result = await Promise.race([work, timeout]);
    if (result === "pending") return { pending: true };
    return result ? { png: result } : { missing: true };
  } finally {
    clearTimeout(timer);
  }
}
