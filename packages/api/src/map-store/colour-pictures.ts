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

import { createHash } from "node:crypto";
import { mapDocument } from "@oxygen/shared";
import type { PrismaClient } from "../generated/prisma/client.js";
import { colourPictureWindow, renderColourPicturePng } from "../render/previews.js";
import { getBlob } from "./blob-store.js";
import { colourSettingsOfReport, DEVIATION_KEY, normaliseColourSettings, pictureDeviationsQuery, reportDeviationKeys, type ColourOrder, type DeviationChoice } from "./colour-settings.js";
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

/** The colour-order route's file name (§4.5): `iof.png` / `source.png` the picture, `.json` the document (row I8a). */
export function parseColourOrderFile(file: string): { order: ColourOrder; format: "png" | "json" } | null {
  const m = /^(.*)\.(png|json)$/.exec(file);
  const order = m ? parseColourOrder(m[1]!) : null;
  return order && m ? { order, format: m[2] as "png" | "json" } : null;
}

/**
 * The overrides a picture is drawn with, as the `deviations` query carries
 * them (row I7): `upper>lower:keep,upper>lower:drop`, normalised (choices
 * equal to the default left out, keys sorted). `null` for a malformed
 * value; `{}` for none.
 */
export function parsePictureDeviations(raw: string | undefined): Record<string, DeviationChoice> | null {
  if (raw === undefined || raw === "") return {};
  if (raw.length > 4000) return null;
  const deviations: Record<string, DeviationChoice> = {};
  for (const part of raw.split(",")) {
    const at = part.lastIndexOf(":");
    const key = part.slice(0, at), choice = part.slice(at + 1);
    if (at <= 0 || !DEVIATION_KEY.test(key) || (choice !== "keep" && choice !== "drop")) return null;
    deviations[key] = choice;
  }
  return normaliseColourSettings({ order: "iof", deviations }).deviations;
}

/**
 * The picture's `map_previews.key` (docs/map-storage.md §4.5): the order,
 * and for an IOF picture drawn with overrides (a `source` document's, row
 * I7) a digest of them, so a picture is never reused across overrides.
 */
export function colourPictureKey(order: ColourOrder, deviations: Readonly<Record<string, DeviationChoice>> = {}): string {
  const q = order === "iof" ? pictureDeviationsQuery(deviations) : "";
  return q ? `${order}-${createHash("sha256").update(q).digest("hex").slice(0, 16)}` : order;
}

export type ColourPictureResult = { png: Buffer; key: string } | { pending: true } | { missing: true } | { failed: string };

/** Only the overrides of deviations in `listed` (the IOF documents of a source list the same deviations). */
const restrictTo = (deviations: Record<string, DeviationChoice>, listed: readonly string[]): Record<string, DeviationChoice> =>
  Object.fromEntries(Object.entries(deviations).filter(([k]) => listed.includes(k)));

/**
 * The overrides a picture request may use (row I7), so the stored keys stay
 * bounded: none unless the document is in the map's own order and the IOF
 * picture is asked for, then only those of deviations a stored IOF document
 * of the same source and corrections lists (when there is one yet; the
 * import narrows them again).
 */
async function pictureOverrides(db: PrismaClient, row: { sourceHash: string; patch: unknown; header: unknown }, order: ColourOrder, asked: Record<string, DeviationChoice> | undefined): Promise<Record<string, DeviationChoice>> {
  if (ownOrderOf(row) !== "source" || order !== "iof" || !asked || !Object.keys(asked).length) return {};
  const patch = mapDocument.parseVersionPatch(row.patch);
  const siblings = await db.mapDocument.findMany({ where: { sourceHash: row.sourceHash }, orderBy: { createdAt: "desc" }, select: { header: true, patch: true, report: true } });
  const iof = siblings.find((d) => (d.header as { colourOrder?: { order?: string } } | null)?.colourOrder?.order === "iof" && mapDocument.sameVersionPatch(d.patch, patch));
  return iof ? restrictTo(asked, reportDeviationKeys(iof.report)) : asked;
}


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
type DocumentRow = { sourceHash: string; patch: unknown; report: unknown; header: unknown };

/** The order a stored document is drawn in, from its header summary (none: before the layers, the map's own). */
const ownOrderOf = (row: { header: unknown }): ColourOrder => (row.header as { colourOrder?: { order?: ColourOrder } } | null)?.colourOrder?.order ?? "source";

/**
 * The document the switch to `order` gives for a stored document (§4.5;
 * row I8a's compare view): the same source, corrections and overrides, the
 * other order — a `source` document lists no deviations, so its IOF side
 * takes `asked` (the map's overrides, row I7). Found by dedup, by waiting
 * for a running job without a target in that setting, or imported by one
 * (`started_by` the requester). Returns its hash and the overrides it
 * lists. Throws when the import fails.
 */
async function importOtherOrder(db: PrismaClient, row: DocumentRow, order: ColourOrder, startedBy: string | null, asked: Record<string, DeviationChoice>): Promise<{ hash: string; asked: Record<string, DeviationChoice> }> {
  const patch = mapDocument.parseVersionPatch(row.patch);
  const colour = { order, deviations: order === "iof" && Object.keys(asked).length ? asked : colourSettingsOfReport(row.report).deviations };
  const running = await runningJobFor(db, row.sourceHash, patch, colour);
  let job = running ?? (await startImportJob(db, { sourceHash: row.sourceHash, startedBy, patch, colour, holdMs: 0 }));
  if (!isTerminal(job.state)) job = (await awaitImportJob(db, job.id)) ?? job;
  if (job.state !== "done" || !job.documentHash) throw new Error(`the ${order} import of ${row.sourceHash} ${job.state === "failed" ? `failed: ${job.error ?? ""}` : `is still ${job.state}`}`);
  // Waited for someone else's job: one of the requester's own (dedup, no worker), so they may read the document (§4.2).
  if (running && (await db.mapImportJob.findUnique({ where: { id: running.id }, select: { startedBy: true } }))?.startedBy !== startedBy) {
    await startImportJob(db, { sourceHash: row.sourceHash, startedBy, patch, colour, holdMs: 0 });
  }
  let listed = asked;
  // The overrides that document lists: the picture's key never names one it does not (bounded keys, row I7).
  if (Object.keys(asked).length) {
    const other = await db.mapDocument.findUnique({ where: { hash: job.documentHash }, select: { report: true } });
    listed = restrictTo(asked, reportDeviationKeys(other?.report));
  }
  return { hash: job.documentHash, asked: listed };
}

async function produce(db: PrismaClient, hash: string, order: ColourOrder, startedBy: string | null, asked: Record<string, DeviationChoice>): Promise<{ png: Buffer; key: string } | null> {
  const row = await db.mapDocument.findUnique({ where: { hash }, select: { sourceHash: true, patch: true, report: true, header: true } });
  if (!row) return null;
  // The import, if any, runs before a whole document is decoded.
  let otherHash: string | null = null;
  if (ownOrderOf(row) !== order) {
    const other = await importOtherOrder(db, row, order, startedBy, asked);
    otherHash = other.hash;
    asked = other.asked;
  }
  const key = colourPictureKey(order, asked);
  // Decoded and drawn inside the one-at-a-time queue (map-storage.md §4.5), never while waiting on the import.
  const png = await serialised(async () => {
    const reviewed = await decodeStored(db, hash);
    const drawn = otherHash ? await decodeStored(db, otherHash) : reviewed;
    if (!reviewed || !drawn) return null;
    return renderColourPicturePng(drawn, colourPictureWindow(reviewed));
  });
  if (!png) return null;
  await writePreview(db, hash, COLOUR_PICTURE_KIND, key, png);
  return { png, key };
}

/**
 * The picture of document `hash` in `order`: the stored row, else rendered
 * (and the other order imported) now. Waits up to `waitMs`; past that the
 * work goes on and `{ pending: true }` says to ask again. `{ missing }`
 * when there is no such document.
 */
export async function colourPicture(db: PrismaClient, hash: string, order: ColourOrder, opts: { startedBy: string | null; waitMs?: number; deviations?: Record<string, DeviationChoice> }): Promise<ColourPictureResult> {
  const row = await db.mapDocument.findUnique({ where: { hash }, select: { sourceHash: true, patch: true, header: true } });
  if (!row) return { missing: true };
  const asked = await pictureOverrides(db, row, order, opts.deviations);
  const key = colourPictureKey(order, asked);
  const stored = await readPreview(db, hash, COLOUR_PICTURE_KIND, key);
  if (stored) return { png: stored, key };
  const id = `${hash}/${COLOUR_PICTURE_KIND}/${key}`;
  const failed = failures.get(id);
  if (failed && Date.now() - failed.at < COLOUR_PICTURE_FAILURE_TTL_MS) return { failed: failed.message };
  const work = once(id, () => produce(db, hash, order, opts.startedBy, asked));
  // A failure is remembered (the panel retries) and reported to the request that is waiting; one after the wait is logged.
  const settled = work.then(
    (out) => (out ?? { missing: true as const }),
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

export type ColourOrderDocumentResult = { documentHash: string } | { pending: true } | { missing: true } | { failed: string };

/**
 * The document the colour switch to `order` gives for document `hash`
 * (docs/map-storage.md §4.5 "The other order's document"; row I8a's
 * compare view): the picture's import without the picture. Its own order
 * is the document itself, no job. The other order: with `deviations` (the
 * map's overrides) on a `source` document's IOF side, found by dedup or
 * imported (`started_by` the requester). The same failure memory and wait
 * as the picture: a failed import is not started again for a while; past
 * `waitMs` the work goes on and `{ pending }` says to ask again.
 */
export async function colourOrderDocument(db: PrismaClient, hash: string, order: ColourOrder, opts: { startedBy: string | null; waitMs?: number; deviations?: Record<string, DeviationChoice> }): Promise<ColourOrderDocumentResult> {
  const row = await db.mapDocument.findUnique({ where: { hash }, select: { sourceHash: true, patch: true, report: true, header: true } });
  if (!row) return { missing: true };
  if (ownOrderOf(row) === order) return { documentHash: hash };
  const asked = await pictureOverrides(db, row, order, opts.deviations);
  // Per requester: the work ends with a job row of theirs (§4.2's own-job clause).
  const id = `${hash}/document/${colourPictureKey(order, asked)}/${opts.startedBy ?? ""}`;
  const failed = failures.get(id);
  if (failed && Date.now() - failed.at < COLOUR_PICTURE_FAILURE_TTL_MS) return { failed: failed.message };
  const work = once<string>(id, async () => (await importOtherOrder(db, row, order, opts.startedBy, asked)).hash);
  const settled = work.then(
    (documentHash): ColourOrderDocumentResult => (documentHash ? { documentHash } : { missing: true }),
    (err: unknown): ColourOrderDocumentResult => {
      const message = err instanceof Error ? err.message : String(err);
      failures.set(id, { at: Date.now(), message });
      console.error(`[map-previews] ${order} document of ${hash}:`, message);
      return { failed: message };
    },
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ColourOrderDocumentResult>((resolve) => { timer = setTimeout(() => resolve({ pending: true }), opts.waitMs ?? colourPictureWaitMs()); });
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
