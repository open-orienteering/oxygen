/**
 * Map patches: storage and delivery (docs/map-patches.md §3; slice G
 * answer 1). One `map_patches` row per event, cloud-owned and not
 * journaled; writes merge per op id with the shared `mergePatch` under the
 * row lock, and a patch is delivered only paired with the document it is
 * keyed onto — the event's pin.
 *
 * A row keyed to another document than the pin (the pin moved and
 * re-resolution, row G11, has not re-keyed it) is **dormant**: kept, not
 * delivered, not writable (§3.2; user 2026-11-13).
 */

import { TRPCError } from "@trpc/server";
import { encodeHlc, mapDocument } from "@oxygen/shared";
import { type PrintPatch, livePrintPatch } from "@oxygen/shared/print";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { nextServerHlc } from "../serverClock.js";
import { eventDocumentHash } from "./event-document.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** The columns a patch is read from. */
export interface PatchRow {
  documentHash: string;
  enabled: boolean;
  ops: unknown;
  symbols: unknown;
  version: bigint;
}

/** What `mapPatch.get`, the route and every write answer (§3.3). */
export interface PatchDelivery {
  /** The row's token as a decimal string; `"0"` when nothing is delivered. */
  version: string;
  /** The patch keyed to the event's pin, or null (no row, no pin, dormant row). */
  patch: mapDocument.MapPatch | null;
}

export const NO_PATCH: PatchDelivery = Object.freeze({ version: "0", patch: null }) as PatchDelivery;

/**
 * The stored `ops` + `symbols` JSON is capped (§3.2): a patch is
 * kilobytes, and it travels inside the one JSON checkout snapshot.
 */
export const MAP_PATCH_MAX_BYTES = 4 * 1024 * 1024;

/** A fresh token: the patch carries no journal entry, so the node clock mints one (as `course_objects`). */
export function nextPatchVersion(): bigint {
  return encodeHlc(nextServerHlc());
}

/** The row as a patch, record keys sorted; null (with a warning) when it does not parse, e.g. written by a newer image. */
export function patchOfRow(row: PatchRow): mapDocument.MapPatch | null {
  const parsed = mapDocument.mapPatchSchema.safeParse({
    documentHash: row.documentHash,
    enabled: row.enabled,
    ops: row.ops,
    symbols: row.symbols,
  });
  if (!parsed.success) {
    console.warn(`[map-patches] row for document ${row.documentHash} does not parse:`, parsed.error.message);
    return null;
  }
  // JSONB reorders object keys; one empty merge restores the sorted form (§1.5).
  return mapDocument.mergePatch(parsed.data, {});
}

/** The delivery rule (§3.3): the row only when it is keyed to the pin. */
export function deliveredPatch(row: PatchRow | null, pinHash: string | null): PatchDelivery {
  if (!row || !pinHash || row.documentHash !== pinHash) return NO_PATCH;
  const patch = patchOfRow(row);
  return patch ? { version: row.version.toString(), patch } : NO_PATCH;
}

export function patchEtag(version: string): string {
  return `"${version}"`;
}

/** JSON with object keys sorted at every depth: equal content, equal text. */
function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const o = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  });
}

/** True when two patches hold the same states (key order ignored). */
export function samePatchContent(a: mapDocument.MapPatch, b: mapDocument.MapPatch): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** `PAYLOAD_TOO_LARGE` when the stored `ops` + `symbols` would pass the cap. */
export function assertPatchSize(patch: mapDocument.MapPatch): void {
  const bytes = Buffer.byteLength(JSON.stringify(patch.ops)) + Buffer.byteLength(JSON.stringify(patch.symbols));
  if (bytes > MAP_PATCH_MAX_BYTES) {
    throw new TRPCError({
      code: "PAYLOAD_TOO_LARGE",
      message: `PATCH_TOO_LARGE: the patch would hold ${bytes} bytes (at most ${MAP_PATCH_MAX_BYTES})`,
    });
  }
}

const ROW_SELECT = { documentHash: true, enabled: true, ops: true, symbols: true, version: true } as const;

/** The event's patch as delivered (§3.3): the one reader for the route, `mapPatch.get` and server consumers (G14). */
export async function eventPatch(db: Db, eventId: bigint): Promise<PatchDelivery> {
  const [pin, row] = await Promise.all([
    eventDocumentHash(db, eventId),
    db.mapPatch.findUnique({ where: { eventId }, select: ROW_SELECT }),
  ]);
  return deliveredPatch(row, pin);
}

/**
 * The delivered patch's version alone (`course.mapMetadata.patchVersion`,
 * §3.3), for a caller that already holds the pin: no parse of the ops.
 */
export async function eventPatchVersion(db: Db, eventId: bigint, pinHash: string | null): Promise<string> {
  if (!pinHash) return NO_PATCH.version;
  const row = await db.mapPatch.findUnique({ where: { eventId }, select: { documentHash: true, version: true } });
  return row && row.documentHash === pinHash ? row.version.toString() : NO_PATCH.version;
}

/**
 * The patch the server's consumers apply to the pin `pinHash` (G14:
 * print, the cut context, `course.checks`, the event map objects;
 * docs/map-patches.md §2.4): the delivered patch with its version, or null
 * when it changes nothing — no pin, no row, a dormant row, disabled or
 * op-less. Null means the pinned document unchanged, so an unpatched or
 * disabled event prints byte-identical to one without corrections (§2.1).
 * Read with the hash the caller already holds, so the patch is never
 * paired with another document than the one it prints.
 */
export async function eventPrintPatch(db: Db, eventId: bigint, pinHash: string | null): Promise<PrintPatch | null> {
  if (!pinHash) return null;
  const row = await db.mapPatch.findUnique({ where: { eventId }, select: ROW_SELECT });
  const { version, patch } = deliveredPatch(row, pinHash);
  return patch ? livePrintPatch(pinHash, { version, patch }) : null;
}

// ---- writes -----------------------------------------------------------------

/**
 * Steps 1–3 of a write (§3.2) inside the caller's transaction: the pin
 * (refused without one, or when `documentHash` names another), the row
 * created if missing and locked, refused when dormant.
 */
async function lockPatchRow(tx: Prisma.TransactionClient, eventId: bigint, documentHash?: string): Promise<{ row: PatchRow; patch: mapDocument.MapPatch }> {
  const pin = await eventDocumentHash(tx, eventId);
  if (!pin) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "PATCH_NO_DOCUMENT: the event has no map document" });
  if (documentHash !== undefined && documentHash !== pin) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `PATCH_DOCUMENT_MISMATCH: the ops are keyed onto ${documentHash}, the event's map is ${pin}`,
    });
  }
  await tx.$executeRaw`
    INSERT INTO "oxygen"."map_patches" ("event_id", "document_hash") VALUES (${eventId}, ${pin})
    ON CONFLICT ("event_id") DO NOTHING`;
  await tx.$queryRaw`SELECT 1 FROM "oxygen"."map_patches" WHERE "event_id" = ${eventId} FOR UPDATE`;
  const row = await tx.mapPatch.findUnique({ where: { eventId }, select: ROW_SELECT });
  if (!row) throw new Error(`map_patches row for event ${eventId} vanished under the lock`);
  // The pin again, under the lock: a pin that moved since step 1 makes the row dormant now.
  const pinNow = await eventDocumentHash(tx, eventId);
  if (row.documentHash !== pin || pinNow !== pin) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `PATCH_STALE: the event's corrections are keyed onto ${row.documentHash}, not the event's map ${pinNow ?? "(none)"}; they wait for re-resolution`,
    });
  }
  const patch = patchOfRow(row);
  if (!patch) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "PATCH_UNREADABLE: the stored patch does not parse" });
  }
  return { row, patch };
}

/** Steps 4–5: write `next` with a new version unless it equals what is stored. */
async function writeIfChanged(tx: Prisma.TransactionClient, eventId: bigint, row: PatchRow, current: mapDocument.MapPatch, next: mapDocument.MapPatch): Promise<PatchDelivery> {
  if (samePatchContent(current, next)) return { version: row.version.toString(), patch: current };
  assertPatchSize(next);
  const version = nextPatchVersion();
  await tx.mapPatch.update({
    where: { eventId },
    data: {
      enabled: next.enabled,
      ops: next.ops as unknown as Prisma.InputJsonValue,
      symbols: next.symbols as unknown as Prisma.InputJsonValue,
      version,
    },
  });
  return { version: version.toString(), patch: next };
}

/** `mapPatch.applyChange` (§3.2): merge `change` per op id into the event's patch under the row lock. */
export function applyPatchChange(db: PrismaClient, eventId: bigint, documentHash: string, change: mapDocument.PatchChange): Promise<PatchDelivery> {
  return db.$transaction(async (tx) => {
    const { row, patch } = await lockPatchRow(tx, eventId, documentHash);
    return writeIfChanged(tx, eventId, row, patch, mapDocument.mergePatch(patch, change));
  });
}

/** `mapPatch.setEnabled` (§1.4, §3.2): the toggle; a row is created (empty, keyed to the pin) when there is none. */
export function setPatchEnabled(db: PrismaClient, eventId: bigint, enabled: boolean): Promise<PatchDelivery> {
  return db.$transaction(async (tx) => {
    const { row, patch } = await lockPatchRow(tx, eventId);
    return writeIfChanged(tx, eventId, row, patch, { ...patch, enabled });
  });
}
