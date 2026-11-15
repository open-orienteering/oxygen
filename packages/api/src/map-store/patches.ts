/**
 * Map patches: storage and delivery (docs/map-patches.md §3; slice G
 * answer 1). One `map_patches` row per event, cloud-owned and not
 * journaled; writes merge per op id with the shared `mergePatch` under the
 * row lock, and a patch is delivered only paired with the document it is
 * keyed onto — the event's pin.
 *
 * A row keyed to another document than the pin (the pin moved and
 * re-resolution has not re-keyed it yet) is **dormant**: kept, not
 * delivered (§3.2; user 2026-11-13). Re-resolution (§4.4, row G11)
 * re-keys it onto the pin — after every pin, on a write to it, and in the
 * re-match pass's sweep.
 */

import { TRPCError } from "@trpc/server";
import { encodeHlc, mapDocument } from "@oxygen/shared";
// A value import only: a print type in this module's signatures would pull the PDF writer into the web build through the router's .d.ts.
import { livePrintPatch } from "@oxygen/shared/print";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { nextServerHlc } from "../serverClock.js";
import { decodedDocument, eventDocumentHash, writePinnedMapFileColumns } from "./event-document.js";
import { synchronizePositionedControlCoordinates } from "../event-crs.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** The columns a patch is read from. */
export interface PatchRow {
  documentHash: string;
  enabled: boolean;
  ops: unknown;
  symbols: unknown;
  unresolved: unknown;
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
    unresolved: row.unresolved,
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

/** `PAYLOAD_TOO_LARGE` when the stored `ops` + `symbols` + `unresolved` would pass the cap. */
export function assertPatchSize(patch: mapDocument.MapPatch): void {
  const bytes = Buffer.byteLength(JSON.stringify(patch.ops)) + Buffer.byteLength(JSON.stringify(patch.symbols)) + Buffer.byteLength(JSON.stringify(patch.unresolved ?? {}));
  if (bytes > MAP_PATCH_MAX_BYTES) {
    throw new TRPCError({
      code: "PAYLOAD_TOO_LARGE",
      message: `PATCH_TOO_LARGE: the patch would hold ${bytes} bytes (at most ${MAP_PATCH_MAX_BYTES})`,
    });
  }
}

const ROW_SELECT = { documentHash: true, enabled: true, ops: true, symbols: true, unresolved: true, version: true } as const;

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
export async function eventPrintPatch(db: Db, eventId: bigint, pinHash: string | null): Promise<{ version: string; patch: mapDocument.MapPatch } | null> {
  const { version, patch } = await eventPatchOnPin(db, eventId, pinHash);
  return patch && pinHash ? livePrintPatch(pinHash, { version, patch }) : null;
}

/** The delivered patch (§3.3) for a pin the caller already holds: the row only when it is keyed to `pinHash`. */
export async function eventPatchOnPin(db: Db, eventId: bigint, pinHash: string | null): Promise<PatchDelivery> {
  if (!pinHash) return NO_PATCH;
  const row = await db.mapPatch.findUnique({ where: { eventId }, select: ROW_SELECT });
  return deliveredPatch(row, pinHash);
}

// ---- writes -----------------------------------------------------------------

/** The event's promote job while it is queued or running (§5 answer 4): a job with both an event and a club map target. */
export async function activePromoteJob(db: Db, eventId: bigint): Promise<{ id: string } | null> {
  return db.mapImportJob.findFirst({
    where: { eventId, clubMapId: { not: null }, state: { in: ["queued", "running"] }, NOT: { patch: { equals: [] } } },
    select: { id: true },
  });
}

/**
 * Steps 1–3 of a write (§3.2) inside the caller's transaction: the pin
 * (refused without one, or when `documentHash` names another), the row
 * created if missing and locked, refused while the event's promote runs
 * (`PATCH_PROMOTING`, §5 answer 4) and when dormant.
 */
export async function lockPatchRow(tx: Prisma.TransactionClient, eventId: bigint, documentHash?: string): Promise<{ row: PatchRow; patch: mapDocument.MapPatch }> {
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
  // Under the lock, so a promote that inserted its job in another transaction is seen once that commits.
  const promoting = await activePromoteJob(tx, eventId);
  if (promoting) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `PATCH_PROMOTING: the event's corrections are being saved to the club map (job ${promoting.id})` });
  }
  // The pin again, under the lock: a pin that moved since step 1 makes the row dormant now.
  const pinNow = await eventDocumentHash(tx, eventId);
  if (row.documentHash !== pin || pinNow !== pin) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `PATCH_STALE: the event's corrections are keyed onto ${row.documentHash}, not the event's map ${pinNow ?? "(none)"}`,
    });
  }
  const patch = patchOfRow(row);
  if (!patch) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "PATCH_UNREADABLE: the stored patch does not parse" });
  }
  return { row, patch };
}

/** The row's columns from a patch, with a fresh version. */
export function rowData(patch: mapDocument.MapPatch, version: bigint) {
  return {
    documentHash: patch.documentHash,
    enabled: patch.enabled,
    ops: patch.ops as unknown as Prisma.InputJsonValue,
    symbols: patch.symbols as unknown as Prisma.InputJsonValue,
    unresolved: (patch.unresolved ?? {}) as unknown as Prisma.InputJsonValue,
    version,
  };
}

/** Steps 4–5: write `next` with a new version unless it equals what is stored. */
async function writeIfChanged(tx: Prisma.TransactionClient, eventId: bigint, row: PatchRow, current: mapDocument.MapPatch, next: mapDocument.MapPatch): Promise<PatchDelivery> {
  if (samePatchContent(current, next)) return { version: row.version.toString(), patch: current };
  assertPatchSize(next);
  const version = nextPatchVersion();
  await tx.mapPatch.update({ where: { eventId }, data: rowData(next, version) });
  return { version: version.toString(), patch: next };
}

const isStale = (err: unknown): boolean => err instanceof TRPCError && err.message.startsWith("PATCH_STALE");

/**
 * A write (§3.2): `write` in a transaction; when it finds the row dormant
 * (`PATCH_STALE`, step 3), the row is re-resolved onto the pin (§4.4) and
 * the write runs once more. `PATCH_STALE` stays only when that cannot run.
 */
export async function writePatch<T = PatchDelivery>(
  db: PrismaClient,
  eventId: bigint,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { timeout: number; maxWait: number },
): Promise<T> {
  try {
    return await db.$transaction(write, options);
  } catch (err) {
    if (!isStale(err)) throw err;
    const r = await reresolveEventPatch(db, eventId);
    if (r.outcome === "failed") throw err;
    return db.$transaction(write, options);
  }
}

/** `mapPatch.applyChange` (§3.2): merge `change` per op id into the event's patch under the row lock. */
export function applyPatchChange(db: PrismaClient, eventId: bigint, documentHash: string, change: mapDocument.PatchChange): Promise<PatchDelivery> {
  return writePatch(db, eventId, async (tx) => {
    const { row, patch } = await lockPatchRow(tx, eventId, documentHash);
    return writeIfChanged(tx, eventId, row, patch, mapDocument.mergePatch(patch, change));
  });
}

/** `mapPatch.setEnabled` (§1.4, §3.2): the toggle; a row is created (empty, keyed to the pin) when there is none. */
export function setPatchEnabled(db: PrismaClient, eventId: bigint, enabled: boolean): Promise<PatchDelivery> {
  return writePatch(db, eventId, async (tx) => {
    const { row, patch } = await lockPatchRow(tx, eventId);
    return writeIfChanged(tx, eventId, row, patch, { ...patch, enabled });
  });
}

/**
 * `mapPatch.attachUnresolved` (§3.2 step 4, §4.3): unresolved entry `key`'s
 * op put onto the pinned document's object `sourceIndex`, the entry
 * dropped. An entry already gone is a no-op (twice equals once); a refusal
 * is `BAD_REQUEST` `PATCH_ATTACH_REFUSED` with the reason.
 */
export async function attachUnresolvedPatchOp(db: PrismaClient, eventId: bigint, documentHash: string, key: string, sourceIndex: number): Promise<PatchDelivery> {
  const doc = await decodedDocument(db, documentHash);
  return writePatch(db, eventId, async (tx) => {
    const { row, patch } = await lockPatchRow(tx, eventId, documentHash);
    if (!patch.unresolved?.[key]) return { version: row.version.toString(), patch };
    if (!doc) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "PATCH_NO_DOCUMENT: the event's map document cannot be read" });
    const r = mapDocument.attachUnresolved(patch, key, doc, sourceIndex);
    if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `PATCH_ATTACH_REFUSED: ${r.reason}` });
    return writeIfChanged(tx, eventId, row, patch, mapDocument.mergePatch(patch, r.change));
  });
}

// ---- re-resolution (§4.4, row G11) ------------------------------------------------

export interface ReresolveResult {
  /** `none`: no row, no pin, or already on it; `rekeyed`: written onto the pin; `failed`: a document or the row cannot be read. */
  outcome: "none" | "rekeyed" | "failed";
  /** The document the row was keyed onto, and the pin it is keyed onto now. */
  from?: string;
  to?: string;
  resolved?: number;
  unresolved?: number;
  error?: string;
}

export const isClient = (db: Db): db is PrismaClient => typeof (db as PrismaClient).$transaction === "function";

/** Prisma's interactive-transaction default (5 s) is short for decoding a club-wide document under the lock. */
export const REKEY_TX = { timeout: 60_000, maxWait: 10_000 } as const;

/**
 * Re-keys the event's patch onto its pin (map-patches §4.4) when the row is
 * keyed to another document: both documents decoded (outside the lock when
 * `db` is a client), then under the row lock `resolvePatch` and one write
 * with a new version — always, also for a row without ops. In the caller's
 * transaction when `db` is one. Never throws for patch or document content:
 * a missing or undecodable document, or a row that does not parse, is
 * `failed` and leaves the row dormant.
 */
export async function reresolveEventPatch(db: Db, eventId: bigint): Promise<ReresolveResult> {
  const [pin, peek] = await Promise.all([
    eventDocumentHash(db, eventId),
    db.mapPatch.findUnique({ where: { eventId }, select: { documentHash: true } }),
  ]);
  if (!pin || !peek || peek.documentHash === pin) return { outcome: "none" };
  const [from, to] = await Promise.all([decodedDocument(db, peek.documentHash), decodedDocument(db, pin)]);
  if (!from || !to) return { outcome: "failed", from: peek.documentHash, to: pin, error: `document ${!from ? peek.documentHash : pin} cannot be read` };

  const rekey = async (tx: Prisma.TransactionClient): Promise<ReresolveResult> => {
    await tx.$queryRaw`SELECT 1 FROM "oxygen"."map_patches" WHERE "event_id" = ${eventId} FOR UPDATE`;
    const [row, pinNow] = await Promise.all([tx.mapPatch.findUnique({ where: { eventId }, select: ROW_SELECT }), eventDocumentHash(tx, eventId)]);
    // Moved meanwhile (another re-key, another pin): what it now needs is that caller's.
    if (!row || pinNow !== pin || row.documentHash !== peek.documentHash) return { outcome: "none" };
    const patch = patchOfRow(row);
    if (!patch) return { outcome: "failed", from: row.documentHash, to: pin, error: "the stored patch does not parse" };
    const r = mapDocument.resolvePatch(from, to, patch, { toHash: pin });
    // Anchors make an unresolved entry larger than its op: a re-key past the cap leaves the row dormant (PATCH_STALE), never throws.
    try {
      assertPatchSize(r.patch);
    } catch (err) {
      return { outcome: "failed", from: row.documentHash, to: pin, error: err instanceof Error ? err.message : String(err) };
    }
    await tx.mapPatch.update({ where: { eventId }, data: rowData(r.patch, nextPatchVersion()) });
    return { outcome: "rekeyed", from: row.documentHash, to: pin, resolved: r.resolved, unresolved: r.unresolved };
  };
  // Every pin today runs on a client (its own transaction here). In a caller's transaction a database error would
  // abort that transaction too, whatever `reresolveAfterPin` catches.
  return isClient(db) ? db.$transaction(rekey, REKEY_TX) : rekey(db);
}

/**
 * The pin hook (`applyJobResult`, map-storage §6.4): `reresolveEventPatch`,
 * logged, never thrown — a re-key that fails leaves the row dormant and
 * never fails the pin.
 */
export async function reresolveAfterPin(db: Db, eventId: bigint): Promise<ReresolveResult> {
  try {
    const r = await reresolveEventPatch(db, eventId);
    if (r.outcome === "failed") console.warn(`[map-patches] event ${eventId}: the patch stays on ${r.from}: ${r.error}`);
    return r;
  } catch (err) {
    console.warn(`[map-patches] event ${eventId}: re-resolution failed:`, err);
    return { outcome: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

// ---- promote (§5, row G12a) --------------------------------------------------------

export interface PromoteCompletion {
  /** `pinned`: the event moved onto the new version and its promoted ops removed; `skipped`: the version stands alone. */
  outcome: "pinned" | "skipped";
  reason?: string;
  versionId?: string;
}

/**
 * The event half of a finished promote job (`applyJobResult` with both
 * targets, map-storage §6.4; map-patches §5 answer 5): under the patch row
 * lock, the last layer's op ids removed from the event's patch — except
 * those the bake skipped (the document report's `corrections.issues` for
 * that layer), which stay as any op that did not apply — and the event's
 * rows of the source pinned to the new version's document, only while the
 * event is still on the base version (else the version stands and the
 * event is left alone, logged). Then the pin's columns, the controls'
 * positions and re-resolution of what is left in the patch (§4.4), as any
 * pin; those steps are logged, never thrown, so the job cannot fail once
 * the event is on the version.
 */
export async function completePromote(
  db: Db,
  job: { eventId: bigint; clubMapId: string; sourceHash: string; documentHash: string; patch: mapDocument.VersionPatch },
): Promise<PromoteCompletion> {
  const last = job.patch.at(-1);
  if (!last) return { outcome: "skipped", reason: "the job carries no layer" };
  const base = job.patch.slice(0, -1);
  const versions = await db.clubMapVersion.findMany({ where: { clubMapId: job.clubMapId, sourceHash: job.sourceHash }, select: { id: true, patch: true } });
  const target = versions.find((v) => mapDocument.sameVersionPatch(v.patch, job.patch));
  const from = versions.find((v) => mapDocument.sameVersionPatch(v.patch, base));
  if (!target) return { outcome: "skipped", reason: "the promoted version is gone" };
  // Ops the bake skipped on the fresh import stay in the event's patch (§5 answer 5).
  const report = await db.mapDocument.findUnique({ where: { hash: job.documentHash }, select: { report: true } });
  const lastLayer = job.patch.length - 1;
  const bakeSkipped = new Set(
    ((report?.report as { corrections?: { issues?: { layer: number; opId: string }[] } } | null)?.corrections?.issues ?? [])
      .filter((i) => i.layer === lastLayer)
      .map((i) => i.opId),
  );
  const promotedIds = Object.keys(last.ops).filter((id) => !bakeSkipped.has(id));

  const move = async (tx: Prisma.TransactionClient): Promise<PromoteCompletion> => {
    await tx.$queryRaw`SELECT 1 FROM "oxygen"."map_patches" WHERE "event_id" = ${job.eventId} FOR UPDATE`;
    const files = await tx.mapFile.findMany({ where: { eventId: job.eventId, sourceHash: job.sourceHash }, select: { clubMapVersionId: true } });
    if (!from || files.length === 0 || files.some((f) => f.clubMapVersionId !== from.id)) {
      return { outcome: "skipped", reason: "the event's map moved while the promote ran", versionId: target.id };
    }
    const row = await tx.mapPatch.findUnique({ where: { eventId: job.eventId }, select: ROW_SELECT });
    const patch = row ? patchOfRow(row) : null;
    if (row && patch) {
      const next = mapDocument.mergePatch(patch, { remove: promotedIds });
      if (!samePatchContent(patch, next)) await tx.mapPatch.update({ where: { eventId: job.eventId }, data: rowData(next, nextPatchVersion()) });
    }
    await tx.mapFile.updateMany({ where: { eventId: job.eventId, sourceHash: job.sourceHash }, data: { documentHash: job.documentHash, clubMapVersionId: target.id } });
    return { outcome: "pinned", versionId: target.id };
  };
  const r = isClient(db) ? await db.$transaction(move, REKEY_TX) : await move(db);
  if (r.outcome !== "pinned") {
    console.warn(`[map-patches] event ${job.eventId}: promote to version ${target.id} not applied to the event: ${r.reason}`);
    return r;
  }
  // The event is on the version now: what follows is the pin's housekeeping, logged and never thrown,
  // so the job cannot fail (and abandonPromote run) after this point.
  try {
    await writePinnedMapFileColumns(db, job.eventId, job.sourceHash, job.documentHash);
    await synchronizePositionedControlCoordinates(db, job.eventId);
  } catch (err) {
    console.warn(`[map-patches] event ${job.eventId}: the pin's columns after the promote:`, err);
  }
  // What stays in the patch (ops that did not apply, unresolved entries) follows the pin (§4.4).
  await reresolveAfterPin(db, job.eventId);
  return r;
}

/**
 * A promote job that failed (§5): its pending version is deleted — and
 * the event's patch, which promote leaves whole until completion, stays.
 * A version an event already pins (a failure after `completePromote`, a
 * re-claimed run that failed) is kept: it holds corrections that left the
 * event's patch. Returns the deleted version ids.
 */
export async function abandonPromote(db: Db, job: { clubMapId: string; sourceHash: string; patch: mapDocument.VersionPatch }): Promise<string[]> {
  if (job.patch.length === 0) return [];
  const versions = await db.clubMapVersion.findMany({
    where: { clubMapId: job.clubMapId, sourceHash: job.sourceHash, mapFiles: { none: {} } },
    select: { id: true, patch: true },
  });
  const pending = versions.filter((v) => mapDocument.sameVersionPatch(v.patch, job.patch)).map((v) => v.id);
  if (pending.length) await db.clubMapVersion.deleteMany({ where: { id: { in: pending }, mapFiles: { none: {} } } });
  return pending;
}
