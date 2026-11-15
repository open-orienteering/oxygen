/**
 * The review round on a stored document (docs/map-storage.md §6.8,
 * docs/map-import.md §2.2; research 06 §5.1): the review payload, the
 * decide step (rows + an import job without a target) and finalise (the
 * reviewed document pinned where the matcher's output was).
 */

import { mapDocument, mapImport, symbolLibrary } from "@oxygen/shared";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { loadClubDecisions, planDecisionWrites, storedDocumentFollowsDecisions, writeDecisions, type ReviewDecision } from "./decisions.js";
import { applyJobResult, startImportJob, type ImportJobRow } from "./jobs.js";
import { readDocumentHead, readObjectsPerSymbol } from "./previews.js";
import { staleReason } from "./rematch.js";
import { terrainReview, type TerrainReview } from "./heightfield.js";

type Db = PrismaClient | Prisma.TransactionClient;

export const symbolPreviewUrl = (hash: string, idx: number) => `/api/map-documents/${hash}/symbols/${idx}.png`;

/** `ISOM2017-2:703` → `/api/library/ISOM2017-2/<release>/703.png` (A5's versioned path, map-storage.md §4.5). */
export function libraryPreviewUrl(canonicalId: string): string | null {
  const colon = canonicalId.indexOf(":");
  if (colon <= 0) return null;
  return `/api/library/${canonicalId.slice(0, colon)}/${symbolLibrary.SYMBOL_LIBRARY_VERSION}/${canonicalId.slice(colon + 1)}.png`;
}

export interface ReviewPayload {
  documentHash: string;
  /** Importing the source now would give this document: current importer, current library release, current decisions. */
  current: boolean;
  library: { id: string; version: string } | null;
  symbols: (Omit<mapImport.ReviewRow, "candidates"> & {
    previewUrl: string | null;
    candidates: (mapImport.ReviewCandidate & { previewUrl: string | null })[];
  })[];
  stack: { colours: mapDocument.MapDocumentHeader["colours"]; alignment: unknown };
  report: Prisma.JsonValue;
  /** The height-field row's state and terrain report (docs/map-storage.md §4.7); never waits for a derive. */
  terrain: TerrainReview;
}

/** Whether a stored document is what its source imports to now (also the re-match pass's test, §6.9). */
export async function isDocumentCurrent(db: Db, doc: { hash: string; importerVersion: string; libraryVersion: string; report: Prisma.JsonValue }, kind: string, header?: mapDocument.MapDocumentHeader): Promise<boolean> {
  if (staleReason(doc, true)) return false;
  return storedDocumentFollowsDecisions(db, doc, await loadClubDecisions(db, kind), header);
}

/** The review payload, or `null` when there is no such document. */
export async function buildReview(db: Db, hash: string): Promise<ReviewPayload | null> {
  const doc = await db.mapDocument.findUnique({
    where: { hash },
    select: { hash: true, importerVersion: true, libraryVersion: true, report: true, source: { select: { kind: true } } },
  });
  if (!doc) return null;
  const head = await readDocumentHead(db, hash);
  if (!head) return null;
  const { header } = head;
  const counts = await readObjectsPerSymbol(db, hash, head);
  const report = doc.report as { matching?: { edition?: string }; colourStack?: unknown } | null;
  const edition = report?.matching?.edition === "iof2022" || report?.matching?.edition === "iof2024" ? report.matching.edition : undefined;
  const rows = mapImport.reviewRows(header, counts, { edition });
  return {
    documentHash: hash,
    current: await isDocumentCurrent(db, doc, doc.source.kind, header),
    library: header.library ?? null,
    symbols: rows.map((r) => ({
      ...r,
      previewUrl: header.symbols[r.symbolIdx].render ? symbolPreviewUrl(hash, r.symbolIdx) : null,
      candidates: r.candidates.map((c) => ({ ...c, previewUrl: libraryPreviewUrl(c.canonicalId) })),
    })),
    stack: { colours: header.colours, alignment: report?.colourStack ?? null },
    report: doc.report,
    terrain: await terrainReview(db, hash),
  };
}

export type DecideResult =
  | { ok: true; job: ImportJobRow; applied: number }
  | { ok: false; reason: "not-found" };

/**
 * Write the decisions, then import the document's source again under them
 * in a job without a target: the result is stored and visible to the
 * decider (§4.2 own-job clause) but pinned nowhere until `finalise`.
 * Throws `DecisionInputError` for a list that does not fit the document.
 */
export async function decideOnDocument(db: PrismaClient, input: { hash: string; decisions: readonly ReviewDecision[]; userId: string | null; holdMs?: number }): Promise<DecideResult> {
  const doc = await db.mapDocument.findUnique({ where: { hash: input.hash }, select: { sourceHash: true, patch: true } });
  const header = doc ? (await readDocumentHead(db, input.hash))?.header : null;
  if (!doc || !header) return { ok: false, reason: "not-found" };
  const writes = planDecisionWrites(header, input.decisions);
  await writeDecisions(db, writes, input.userId);
  // The reviewed document's corrections come along (docs/map-patches.md §5 answer 1).
  const job = await startImportJob(db, { sourceHash: doc.sourceHash, startedBy: input.userId, holdMs: input.holdMs, patch: mapDocument.parseVersionPatch(doc.patch) });
  return { ok: true, job, applied: writes.length };
}

export type FinaliseTarget = { kind: "event"; eventId: bigint } | { kind: "club"; clubMapId: string };

export type FinaliseResult =
  | { ok: true; pinned: number; previous: string[] }
  | { ok: false; reason: "not-found" | "no-target" | "source-mismatch" };

/**
 * Pin a reviewed document where its source is the target's current map:
 * the event's `map_files` rows carrying that source, or the club map's
 * version of that source (its `document_hash` moves, §6.4). The same path
 * as a job's pins (`applyJobResult`), so it is idempotent and finalising
 * the matcher's own output is a no-op. A target is its source *and* its
 * version patch (docs/map-patches.md §5 answer 1): a document baked with
 * other corrections than the target's is `source-mismatch`.
 */
export async function finaliseDocument(db: Db, hash: string, target: FinaliseTarget): Promise<FinaliseResult> {
  const doc = await db.mapDocument.findUnique({ where: { hash }, select: { sourceHash: true, patch: true } });
  if (!doc) return { ok: false, reason: "not-found" };
  const patch = mapDocument.parseVersionPatch(doc.patch);
  if (target.kind === "event") {
    const rows = await db.mapFile.findMany({
      where: { eventId: target.eventId },
      select: { sourceHash: true, documentHash: true, document: { select: { patch: true } }, clubMapVersion: { select: { patch: true } } },
    });
    if (!rows.length) return { ok: false, reason: "no-target" };
    // The row's corrections: those of the document it pins, else (unpinned) those of the club version it came from.
    const rowPatch = (r: (typeof rows)[number]) => (r.documentHash ? (r.document?.patch ?? null) : (r.clubMapVersion?.patch ?? null));
    const matching = rows.filter((r) => r.sourceHash === doc.sourceHash && mapDocument.sameVersionPatch(rowPatch(r), patch));
    if (!matching.length) return { ok: false, reason: "source-mismatch" };
    await applyJobResult(db, { eventId: target.eventId, clubMapId: null, sourceHash: doc.sourceHash, documentHash: hash, patch });
    return { ok: true, pinned: matching.length, previous: distinct(matching.map((r) => r.documentHash)) };
  }
  const map = await db.clubMap.findUnique({ where: { id: target.clubMapId }, select: { id: true } });
  if (!map) return { ok: false, reason: "no-target" };
  const versions = await db.clubMapVersion.findMany({ where: { clubMapId: target.clubMapId, sourceHash: doc.sourceHash }, select: { documentHash: true, patch: true } });
  const matching = versions.filter((v) => mapDocument.sameVersionPatch(v.patch, patch));
  if (!matching.length) return { ok: false, reason: "source-mismatch" };
  await applyJobResult(db, { eventId: null, clubMapId: target.clubMapId, sourceHash: doc.sourceHash, documentHash: hash, patch });
  return { ok: true, pinned: matching.length, previous: distinct(matching.map((v) => v.documentHash)) };
}

function distinct(hashes: (string | null)[]): string[] {
  return [...new Set(hashes.filter((h): h is string => h !== null))].sort();
}
