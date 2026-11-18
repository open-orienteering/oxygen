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
import { awaitImportJob, getImportJob, isTerminal, startImportJob, type ImportJobRow } from "./jobs.js";
import { once, readPreview, serialised, writePreview } from "./previews.js";

export const COLOUR_PICTURE_KIND = "colour-order" as const;
/** How long the route waits for a picture whose other order is still importing before answering 503. */
export const colourPictureWaitMs = (): number => Number(process.env.MAP_COLOUR_PICTURE_WAIT_MS ?? 20_000);
/** A failed other-order import is not started again for this long: the panel's image retries would each start one. */
export const COLOUR_PICTURE_FAILURE_TTL_MS = 10 * 60_000;
const failures = new Map<string, { at: number; message: string }>();

/** Forget remembered failures (tests). */
export function resetColourPictureFailures(): void {
  failures.clear();
}

export function parseColourOrder(raw: string): ColourOrder | null {
  return raw === "iof" || raw === "source" ? raw : null;
}

export type ColourPictureResult = { png: Buffer } | { pending: true } | { missing: true } | { failed: string };


/**
 * A queued or running job without a target importing this source in this setting (a switch just pressed, another
 * instance's picture): wait for it instead of starting a second one.
 */
async function runningJobFor(db: PrismaClient, sourceHash: string, patch: mapDocument.VersionPatch, colour: { order: ColourOrder; deviations: Record<string, string> }): Promise<ImportJobRow | null> {
  const rows = await db.mapImportJob.findMany({
    where: { sourceHash, eventId: null, clubMapId: null, state: { in: ["queued", "running"] }, colour: { equals: { order: colour.order, deviations: colour.deviations } } },
    orderBy: { createdAt: "desc" },
    select: { id: true, patch: true },
  });
  const row = rows.find((r) => mapDocument.sameVersionPatch(r.patch, patch));
  return row ? getImportJob(db, row.id) : null;
}

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
  const row = await db.mapDocument.findUnique({ where: { hash }, select: { sourceHash: true, patch: true, report: true, header: true } });
  if (!row) return null;
  // The stored header summary says the order (none: before the layers, the map's own), so the import, if any, runs
  // before a whole document is decoded.
  const ownOrder: ColourOrder = (row.header as { colourOrder?: { order?: ColourOrder } } | null)?.colourOrder?.order ?? "source";
  let otherHash: string | null = null;
  if (ownOrder !== order) {
    // The document the switch gives: the same corrections and overrides, the other order.
    const patch = mapDocument.parseVersionPatch(row.patch);
    const colour = { order, deviations: colourSettingsOfReport(row.report).deviations };
    let job = (await runningJobFor(db, row.sourceHash, patch, colour)) ?? (await startImportJob(db, { sourceHash: row.sourceHash, startedBy, patch, colour, holdMs: 0 }));
    if (!isTerminal(job.state)) job = (await awaitImportJob(db, job.id)) ?? job;
    if (job.state !== "done" || !job.documentHash) throw new Error(`the ${order} import of ${row.sourceHash} ${job.state === "failed" ? `failed: ${job.error ?? ""}` : `is still ${job.state}`}`);
    otherHash = job.documentHash;
  }
  // Decoded and drawn inside the one-at-a-time queue (map-storage.md §4.5), never while waiting on the import.
  const png = await serialised(async () => {
    const reviewed = await decodeStored(db, hash);
    const drawn = otherHash ? await decodeStored(db, otherHash) : reviewed;
    if (!reviewed || !drawn) return null;
    return renderColourPicturePng(drawn, colourPictureWindow(reviewed));
  });
  if (!png) return null;
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
  const id = `${hash}/${COLOUR_PICTURE_KIND}/${order}`;
  const failed = failures.get(id);
  if (failed && Date.now() - failed.at < COLOUR_PICTURE_FAILURE_TTL_MS) return { failed: failed.message };
  const work = once(id, () => produce(db, hash, order, opts.startedBy));
  // A failure is remembered (the panel retries) and reported to the request that is waiting; one after the wait is logged.
  const settled = work.then(
    (png) => (png ? { png } : { missing: true as const }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      failures.set(id, { at: Date.now(), message });
      console.error(`[map-previews] colour picture ${id}:`, message);
      return { failed: message };
    },
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ pending: true }>((resolve) => { timer = setTimeout(() => resolve({ pending: true }), opts.waitMs ?? colourPictureWaitMs()); });
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
