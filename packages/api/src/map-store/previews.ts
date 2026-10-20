/**
 * Preview rows and the library preview cache (docs/map-storage.md §4.5).
 *
 * Document previews are `map_previews` rows, content-addressed by
 * `(document_hash, kind, key)`, written once with `createMany …
 * skipDuplicates` and never updated. A missing row is rendered on demand
 * through the same write path, so documents stored before stage 10
 * existed, the dedup short-cut and a failed derive all converge on one
 * row. Library previews are a function of the library version alone and
 * live in a bounded in-memory map, never in the database (07 §4.1).
 */

import { mapDocument, symbolLibrary } from "@oxygen/shared";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { THUMBNAIL_MAX_OBJECTS, renderSwatchPng, renderThumbnailPng, stackColour } from "../render/previews.js";
import { getBlob } from "./blob-store.js";

type Db = PrismaClient | Prisma.TransactionClient;

export type PreviewKind = "thumbnail" | "symbol";

// ---- request parsing ----------------------------------------------------------

/** `:idx` of `symbols/:idx.png`: a non-negative safe integer without sign or leading zeros. */
export function parseSymbolIdx(raw: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** `:code` of the library route: the entry id without the library prefix (`418`, `302.b`). */
export const LIBRARY_CODE = /^\d{3}(\.\d{1,2})?(\.[a-z])?$/;

/** Strip a `.png` suffix; `null` when absent. */
export function stripPng(file: string): string | null {
  return file.endsWith(".png") ? file.slice(0, -4) : null;
}

export function previewEtag(hash: string, kind: PreviewKind, key: string): string {
  return kind === "thumbnail" ? `"${hash}/thumbnail"` : `"${hash}/symbols/${key}"`;
}

export function libraryPreviewEtag(libraryId: string, version: string, code: string): string {
  return `"${libraryId}@${version}/${code}"`;
}

// ---- rows -----------------------------------------------------------------------

export async function readPreview(db: Db, hash: string, kind: PreviewKind, key: string): Promise<Buffer | null> {
  const row = await db.mapPreview.findUnique({ where: { documentHash_kind_key: { documentHash: hash, kind, key } }, select: { png: true } });
  return row ? Buffer.from(row.png) : null;
}

async function writePreview(db: Db, hash: string, kind: PreviewKind, key: string, png: Buffer): Promise<void> {
  await db.mapPreview.createMany({ data: [{ documentHash: hash, kind, key, png: new Uint8Array(png) }], skipDuplicates: true });
}

/** Renders of the same row in flight on this instance share one promise. */
const inFlight = new Map<string, Promise<Buffer | null>>();
function once(id: string, fn: () => Promise<Buffer | null>): Promise<Buffer | null> {
  let p = inFlight.get(id);
  if (!p) {
    p = fn().finally(() => inFlight.delete(id));
    inFlight.set(id, p);
  }
  return p;
}

/** Thumbnails decode and symbolise a whole document; one at a time per instance bounds the memory. */
let thumbnailQueue: Promise<unknown> = Promise.resolve();
function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const run = thumbnailQueue.then(fn, fn);
  thumbnailQueue = run.catch(() => undefined);
  return run;
}

function overCap(hash: string, objects: number): null {
  console.warn(`[map-previews] no thumbnail for ${hash}: ${objects} objects is over the cap of ${THUMBNAIL_MAX_OBJECTS}`);
  return null;
}

/**
 * The thumbnail row, rendered and written when missing. `null` when there
 * is no such document or it is over the object cap (logged).
 */
export function getOrRenderThumbnail(db: Db, hash: string): Promise<Buffer | null> {
  return once(`${hash}/thumbnail`, async () => {
    const existing = await readPreview(db, hash, "thumbnail", "");
    if (existing) return existing;
    // The stored header summary (§3) carries the object count, so an over-cap document costs no blob read.
    const doc = await db.mapDocument.findUnique({ where: { hash }, select: { header: true } });
    if (!doc) return null;
    const objects = (doc.header as { objects?: { count?: number } } | null)?.objects?.count;
    if (objects !== undefined && objects > THUMBNAIL_MAX_OBJECTS) return overCap(hash, objects);
    const bytes = await getBlob(db, "map_documents", hash);
    if (!bytes) return null;
    const result = await serialised(() => renderThumbnailPng(bytes));
    if (!("png" in result)) return overCap(hash, result.objects);
    await writePreview(db, hash, "thumbnail", "", result.png);
    return result.png;
  });
}

/**
 * The swatch row of `header.symbols[idx]`, rendered and written when
 * missing. `null` when there is no such document, `idx` is out of range,
 * or the symbol has no render.
 */
export function getOrRenderSymbolPreview(db: Db, hash: string, idx: number): Promise<Buffer | null> {
  const key = String(idx);
  return once(`${hash}/symbols/${key}`, async () => {
    const existing = await readPreview(db, hash, "symbol", key);
    if (existing) return existing;
    const header = await readDocumentHeader(db, hash);
    const symbol = header?.symbols[idx];
    if (!header || !symbol?.render) return null;
    const png = await renderSwatchPng(symbol.render, stackColour(header.colours));
    await writePreview(db, hash, "symbol", key, png);
    return png;
  });
}

/** The header alone, through two range reads instead of the whole document. */
export async function readDocumentHeader(db: Db, hash: string): Promise<mapDocument.MapDocumentHeader | null> {
  return (await readDocumentHead(db, hash))?.header ?? null;
}

/** The header and its byte length (preamble bytes 8–11). */
export async function readDocumentHead(db: Db, hash: string): Promise<{ header: mapDocument.MapDocumentHeader; headerLength: number } | null> {
  const preamble = await getBlob(db, "map_documents", hash, { start: 0, end: 11 });
  if (!preamble || preamble.byteLength < 12) return null;
  const headerLength = preamble.readUInt32LE(8);
  const head = await getBlob(db, "map_documents", hash, { start: 0, end: 12 + headerLength - 1 });
  return head ? { header: mapDocument.readMapDocumentHeader(head).header, headerLength } : null;
}

/** Objects per header symbol, from one range read of the attrs section. */
export async function readObjectsPerSymbol(db: Db, hash: string, head: { header: mapDocument.MapDocumentHeader; headerLength: number }): Promise<number[]> {
  const { offset, length } = mapDocument.attrsSectionRange(head.header, head.headerLength);
  if (length === 0) return new Array<number>(head.header.symbols.length).fill(0);
  const attrs = await getBlob(db, "map_documents", hash, { start: offset, end: offset + length - 1 });
  if (!attrs || attrs.byteLength !== length) throw new Error(`map document ${hash}: attrs section unreadable`);
  return mapDocument.objectsPerSymbol(attrs, head.header.symbols.length);
}

/**
 * Import stage 10 (docs/map-import.md §1): make sure the thumbnail row
 * exists. Never throws — previews are cache, a failure is logged and the
 * route renders on the next request.
 */
export async function deriveDocumentPreviews(db: Db, hash: string): Promise<void> {
  try {
    await getOrRenderThumbnail(db, hash);
  } catch (err: unknown) {
    console.error(`[map-previews] derive ${hash} failed:`, err instanceof Error ? err.message : err);
  }
}

// ---- library previews ---------------------------------------------------------

/** Bounded LRU: a swatch is a few kB, both libraries together are a few hundred entries. */
export const LIBRARY_CACHE_ENTRIES = 512;
const libraryCache = new Map<string, Promise<Buffer | null>>();

export function resetLibraryPreviewCache(): void {
  libraryCache.clear();
}

export function libraryPreviewCacheSize(): number {
  return libraryCache.size;
}

/**
 * Swatch of library entry `<libraryId>:<code>` in the library's own
 * palette edition, at reference scale. `null` when the version is not the
 * current one or there is no such entry.
 */
export function libraryPreviewPng(libraryId: symbolLibrary.SymbolLibraryId, version: string, code: string): Promise<Buffer | null> {
  if (version !== symbolLibrary.SYMBOL_LIBRARY_VERSION) return Promise.resolve(null);
  const id = `${libraryId}:${code}`;
  const hit = libraryCache.get(id);
  if (hit) {
    libraryCache.delete(id);
    libraryCache.set(id, hit);
    return hit;
  }
  const p = (async () => {
    const lib = symbolLibrary.materialiseLibrary(libraryId);
    const i = lib.library.entries.findIndex((e) => e.id === id);
    if (i < 0) return null;
    return renderSwatchPng(lib.symbols[i], stackColour(lib.colours));
  })();
  // A failed render is not cached.
  p.catch(() => libraryCache.delete(id));
  libraryCache.set(id, p);
  while (libraryCache.size > LIBRARY_CACHE_ENTRIES) libraryCache.delete(libraryCache.keys().next().value!);
  return p;
}
