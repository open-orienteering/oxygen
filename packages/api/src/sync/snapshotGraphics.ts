/**
 * The graphics part of the venue checkout snapshot (docs/map-storage.md
 * §7.2, slice G answer 4).
 *
 * The box prints from its own copy, so the `graphics` rows the event's
 * templates, sheets and course objects draw travel with the checkout:
 * every graphic of the event, and the club graphics (`event_id` NULL) one
 * of those rows references. JSON references them by number (`graphicId`),
 * so each row keeps the cloud's `id`. The snapshot carries the rows
 * without bytes, each with a SHA-256 the exporter computes; the venue
 * fetches the bytes through `lease.exportBlob` (`table: "graphics"`) in
 * the same 4 MiB slices as the map blobs and checks size and hash before
 * inserting.
 */

import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { sliceRanges } from "../map-store/source-routes.js";
import {
  EXPORT_BLOB_MAX_BYTES,
  exportBlobSlice,
  type ExportBlobInput,
  type ExportBlobResult,
  type GraphicBlobInput,
} from "./snapshotMaps.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** A `graphics` row on the wire: no bytes, the id and size as the cloud has them, the hash computed at export. */
export interface SnapshotGraphic {
  /** The cloud's id, decimal. */
  id: string;
  /** A club graphic (`event_id` NULL), shared by the club's events. */
  club: boolean;
  name: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  /** ISO time over HTTP, a Date in process. */
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface SnapshotGraphicBlobs {
  /** Bytes fetched from the peer, by id. A club graphic the box holds with the same hash is absent. */
  bytes: Map<string, Buffer>;
  fetchedBytes: number;
}

export type GraphicSliceFetcher = (id: string, start: number, length: number) => Promise<ExportBlobResult>;

// ---- pure helpers -----------------------------------------------------------

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function positiveInt(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/**
 * Sorted, distinct graphic ids the layout rows reference: `graphicId` of
 * image objects in templates' and sheets' `objects`, and `props.graphicId`
 * of course objects. Malformed JSON contributes nothing.
 */
export function referencedGraphicIds(rows: {
  templateObjects: readonly unknown[];
  sheetObjects: readonly unknown[];
  courseObjectProps: readonly unknown[];
}): string[] {
  const ids = new Set<number>();
  for (const objects of [...rows.templateObjects, ...rows.sheetObjects]) {
    if (!Array.isArray(objects)) continue;
    for (const o of objects) {
      if (!o || typeof o !== "object") continue;
      const rec = o as Record<string, unknown>;
      const id = rec.kind === "image" ? positiveInt(rec.graphicId) : null;
      if (id !== null) ids.add(id);
    }
  }
  for (const props of rows.courseObjectProps) {
    if (!props || typeof props !== "object") continue;
    const id = positiveInt((props as Record<string, unknown>).graphicId);
    if (id !== null) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b).map(String);
}

/** The bytes are the graphic the snapshot names: size and SHA-256. */
export function verifyGraphic(g: Pick<SnapshotGraphic, "id" | "sizeBytes" | "sha256">, bytes: Uint8Array): void {
  if (bytes.byteLength !== g.sizeBytes) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Checkout: graphic ${g.id} arrived with ${bytes.byteLength} bytes, expected size ${g.sizeBytes}.`,
    });
  }
  const got = sha256(bytes);
  if (got !== g.sha256) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Checkout: graphic ${g.id} arrived with hash ${got}.` });
  }
}

/** Fetch one graphic slice by slice and verify the whole. */
export async function fetchGraphic(g: Pick<SnapshotGraphic, "id" | "sizeBytes" | "sha256">, fetchSlice: GraphicSliceFetcher): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const range of sliceRanges(g.sizeBytes, EXPORT_BLOB_MAX_BYTES)) {
    const length = range.end - range.start + 1;
    const slice = await fetchSlice(g.id, range.start, length);
    if (slice.sizeBytes !== g.sizeBytes) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `Checkout: the peer reports size ${slice.sizeBytes} for graphic ${g.id}, the snapshot ${g.sizeBytes}.`,
      });
    }
    const bytes = Buffer.from(slice.base64, "base64");
    if (bytes.length !== length) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `Checkout: slice ${range.start}+${length} of graphic ${g.id} came back with ${bytes.length} bytes.`,
      });
    }
    parts.push(bytes);
  }
  const whole = Buffer.concat(parts);
  verifyGraphic(g, whole);
  return whole;
}

// ---- exporter (cloud) -------------------------------------------------------

/** The graphic ids the event's layout rows reference, read from the database (the `exportBlob` gate). */
async function eventGraphicReferences(db: Db, eventId: bigint): Promise<string[]> {
  const [templates, sheets, objects] = await Promise.all([
    db.mapTemplate.findMany({ where: { eventId }, select: { objects: true } }),
    db.courseMap.findMany({ where: { eventId }, select: { objects: true } }),
    db.courseObject.findMany({ where: { eventId }, select: { props: true } }),
  ]);
  return referencedGraphicIds({
    templateObjects: templates.map((t) => t.objects as unknown),
    sheetObjects: sheets.map((s) => s.objects as unknown),
    courseObjectProps: objects.map((o) => o.props as unknown),
  });
}

/** Every graphic of the event, and the club graphics its layout rows reference, without bytes. */
export async function exportSnapshotGraphics(db: Db, eventId: bigint): Promise<SnapshotGraphic[]> {
  const referenced = (await eventGraphicReferences(db, eventId)).map((id) => BigInt(id));
  const rows = await db.graphic.findMany({
    where: { OR: [{ eventId }, { eventId: null, id: { in: referenced } }] },
    orderBy: { id: "asc" },
  });
  return rows.map((g) => ({
    id: g.id.toString(),
    club: g.eventId === null,
    name: g.name,
    mime: g.mime,
    sizeBytes: g.data.byteLength,
    sha256: sha256(g.data),
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  }));
}

/** `lease.exportBlob` for a graphic: the event's own, or a club graphic the event references; otherwise `NOT_FOUND`. */
export async function exportGraphicSlice(db: Db, eventId: bigint, input: GraphicBlobInput): Promise<ExportBlobResult> {
  const id = BigInt(input.id);
  const row = await db.graphic.findUnique({ where: { id }, select: { eventId: true, data: true } });
  const allowed =
    row !== null &&
    (row.eventId === eventId || (row.eventId === null && (await eventGraphicReferences(db, eventId)).includes(input.id)));
  if (!row || !allowed) {
    throw new TRPCError({ code: "NOT_FOUND", message: `graphics ${input.id} is not drawn by this event.` });
  }
  const sizeBytes = row.data.byteLength;
  if (input.start >= sizeBytes) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `start ${input.start} is past the end (${sizeBytes} bytes).` });
  }
  const end = Math.min(input.start + input.length, sizeBytes);
  return { base64: Buffer.from(row.data.subarray(input.start, end)).toString("base64"), sizeBytes };
}

/** `lease.exportBlob`: a map blob by hash, or a graphic by id. */
export async function exportPeerBlobSlice(db: Db, eventId: bigint, input: ExportBlobInput): Promise<ExportBlobResult> {
  return input.table === "graphics" ? exportGraphicSlice(db, eventId, input) : exportBlobSlice(db, eventId, input);
}

// ---- importer (venue) -------------------------------------------------------

/**
 * Fetch the graphics' bytes before the import transaction. The event's
 * graphics are always fetched (the import's event delete cascades them); a
 * club graphic is skipped when the box holds that id with the same hash.
 */
export async function fetchSnapshotGraphics(
  db: Db,
  graphics: readonly SnapshotGraphic[],
  fetchSlice: GraphicSliceFetcher,
): Promise<SnapshotGraphicBlobs> {
  const out: SnapshotGraphicBlobs = { bytes: new Map(), fetchedBytes: 0 };
  for (const g of graphics) {
    if (g.club) {
      const held = await db.graphic.findUnique({ where: { id: BigInt(g.id) }, select: { eventId: true, data: true } });
      if (held && held.eventId === null && sha256(held.data) === g.sha256) continue;
    }
    out.bytes.set(g.id, await fetchGraphic(g, fetchSlice));
    out.fetchedBytes += g.sizeBytes;
  }
  return out;
}

/**
 * Insert the graphics inside the snapshot transaction, after the event
 * row, each under the cloud's id. A local row in a travelling id's place
 * (one a box uploaded itself, outside a checkout) is replaced: the box's
 * `graphics` mirror the cloud by id, since the layout JSON references them
 * by number. The id sequence is then moved past the largest id, so a later
 * local upload does not collide.
 */
export async function importSnapshotGraphics(
  tx: Prisma.TransactionClient,
  eventId: bigint,
  graphics: readonly SnapshotGraphic[],
  blobs: SnapshotGraphicBlobs,
): Promise<number> {
  let written = 0;
  for (const g of graphics) {
    const bytes = blobs.bytes.get(g.id);
    if (!bytes) {
      // Only a club graphic held with the same hash is skipped by the fetch.
      if (g.club) continue;
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Checkout: graphic ${g.id} is missing on this node.` });
    }
    const id = BigInt(g.id);
    await tx.graphic.deleteMany({ where: { id } });
    await tx.graphic.create({
      data: {
        id,
        eventId: g.club ? null : eventId,
        name: g.name,
        mime: g.mime,
        data: Uint8Array.from(bytes),
        sizeBytes: g.sizeBytes,
        createdAt: new Date(g.createdAt),
        updatedAt: new Date(g.updatedAt),
      },
    });
    written++;
  }
  if (written > 0) {
    await tx.$queryRaw`SELECT setval(pg_get_serial_sequence('oxygen.graphics', 'id'), GREATEST((SELECT MAX(id) FROM oxygen.graphics), 1))`;
  }
  return written;
}
