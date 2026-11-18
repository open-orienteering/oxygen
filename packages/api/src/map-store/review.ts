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
import { colourSettingsOfReport, colourTargetKey, documentFollowsColour, loadColourSettings, loadRecordedColours, reportDeviationKeys, withDeviationChoice, writeColourSettings, type DeviationChoiceInput, type ColourTarget, type MapColourSettings } from "./colour-settings.js";
import { buildColourReview, type ColourReview } from "./review-colours.js";

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
  /** The colour panel (docs/map-symbols.md §8.7 "Colour layers"): layers, deviations, the target's setting, the pictures. */
  colour: ColourReview;
}

/**
 * Whether a stored document is what its source imports to now (also the
 * re-match pass's test, §6.9); with a map's colour setting, also in that
 * setting (docs/map-symbols.md §9.3 "Per map (row I6)").
 */
export async function isDocumentCurrent(db: Db, doc: { hash: string; importerVersion: string; libraryVersion: string; report: Prisma.JsonValue }, kind: string, header?: mapDocument.MapDocumentHeader, colour?: MapColourSettings | null): Promise<boolean> {
  if (staleReason(doc, true)) return false;
  if (colour && !documentFollowsColour({ report: doc.report, recorded: (await loadRecordedColours(db, [doc.hash])).get(doc.hash) }, colour)) return false;
  return storedDocumentFollowsDecisions(db, doc, await loadClubDecisions(db, kind), header);
}

/** Whose review: a club map series, or an event (its map of the document's source). */
export type ReviewTarget = { kind: "club"; clubMapId: string } | { kind: "event"; eventId: bigint };

/** The colour target of a review target for a document of `sourceHash`; `null` when the target has no such map. */
export async function colourTargetOf(db: Db, target: ReviewTarget, sourceHash: string): Promise<ColourTarget | null> {
  if (target.kind === "club") {
    const v = await db.clubMapVersion.findFirst({ where: { clubMapId: target.clubMapId, sourceHash }, select: { id: true } });
    return v ? { kind: "club", clubMapId: target.clubMapId } : null;
  }
  const f = await db.mapFile.findFirst({ where: { eventId: target.eventId, sourceHash }, select: { id: true } });
  return f ? { kind: "event", eventId: target.eventId, sourceHash } : null;
}

/** The review payload, or `null` when there is no such document. `target`: the map the review is for, whose colour setting it shows. */
export async function buildReview(db: Db, hash: string, target?: ReviewTarget | null): Promise<ReviewPayload | null> {
  const doc = await db.mapDocument.findUnique({
    where: { hash },
    select: { hash: true, sourceHash: true, importerVersion: true, libraryVersion: true, report: true, source: { select: { kind: true } } },
  });
  if (!doc) return null;
  const colourTarget = target ? await colourTargetOf(db, target, doc.sourceHash) : null;
  const setting = colourTarget ? await loadColourSettings(db, colourTarget) : null;
  const head = await readDocumentHead(db, hash);
  if (!head) return null;
  const { header } = head;
  const counts = await readObjectsPerSymbol(db, hash, head);
  const report = doc.report as { matching?: { edition?: string }; colourStack?: unknown } | null;
  const edition = report?.matching?.edition === "iof2022" || report?.matching?.edition === "iof2024" ? report.matching.edition : undefined;
  const rows = mapImport.reviewRows(header, counts, { edition });
  return {
    documentHash: hash,
    current: await isDocumentCurrent(db, doc, doc.source.kind, header, setting),
    library: header.library ?? null,
    symbols: rows.map((r) => ({
      ...r,
      previewUrl: header.symbols[r.symbolIdx].render ? symbolPreviewUrl(hash, r.symbolIdx) : null,
      candidates: r.candidates.map((c) => ({ ...c, previewUrl: libraryPreviewUrl(c.canonicalId) })),
    })),
    stack: { colours: header.colours, alignment: report?.colourStack ?? null },
    report: doc.report,
    terrain: await terrainReview(db, hash),
    colour: buildColourReview(hash, header, doc.report, setting),
  };
}

export type ColourChangeResult =
  | { ok: true; settings: MapColourSettings; job: ImportJobRow }
  | { ok: false; reason: "not-found" | "no-target" | "source-mismatch" };

/**
 * Change a map's colour setting and import the document's source again in
 * it, as `decide` does (docs/map-symbols.md §9.3 "Per map (row I6)"): the
 * setting is written on the target — the club map series, or the event's
 * map of the document's source — and the job, without a target, carries
 * it with the reviewed document's corrections; nothing is pinned until
 * `finalise`. `change` maps the stored setting to the new one: row I6's
 * order switch, row I7's deviation overrides.
 */
export async function changeColourSettings(
  db: PrismaClient,
  input: { hash: string; target: ReviewTarget; change: (s: MapColourSettings) => MapColourSettings; userId: string | null; holdMs?: number },
): Promise<ColourChangeResult> {
  const doc = await db.mapDocument.findUnique({ where: { hash: input.hash }, select: { sourceHash: true, patch: true } });
  if (!doc) return { ok: false, reason: "not-found" };
  if (input.target.kind === "club") {
    const map = await db.clubMap.findUnique({ where: { id: input.target.clubMapId }, select: { id: true } });
    if (!map) return { ok: false, reason: "no-target" };
  } else if (!(await db.mapFile.findFirst({ where: { eventId: input.target.eventId }, select: { id: true } }))) {
    return { ok: false, reason: "no-target" };
  }
  const colourTarget = await colourTargetOf(db, input.target, doc.sourceHash);
  if (!colourTarget) return { ok: false, reason: "source-mismatch" };
  // Read, change and write under a lock on the target: a deviation change depends on the stored setting (row I7),
  // so two changes at once must not lose one.
  const settings = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`map-colour:${colourTargetKey(colourTarget)}`}))`;
    return writeColourSettings(tx, colourTarget, input.change(await loadColourSettings(tx, colourTarget)), input.userId);
  });
  const job = await startImportJob(db, { sourceHash: doc.sourceHash, startedBy: input.userId, holdMs: input.holdMs, patch: mapDocument.parseVersionPatch(doc.patch), colour: settings });
  return { ok: true, settings, job };
}

export type DeviationChangeResult = ColourChangeResult | { ok: false; reason: "unknown-deviation" };

/**
 * Override one deviation of a map, or reset it (row I7; docs/map-symbols.md
 * §9.3 "Overrides (row I7)"): `changeColourSettings` with the one choice
 * changed. `keep` and `drop` name a deviation the reviewed document lists;
 * `default` removes the key whatever the document lists.
 */
export async function changeDeviation(
  db: PrismaClient,
  input: { hash: string; target: ReviewTarget; key: string; choice: DeviationChoiceInput; userId: string | null; holdMs?: number },
): Promise<DeviationChangeResult> {
  const doc = await db.mapDocument.findUnique({ where: { hash: input.hash }, select: { report: true } });
  if (!doc) return { ok: false, reason: "not-found" };
  if (input.choice !== "default" && !reportDeviationKeys(doc.report).includes(input.key)) return { ok: false, reason: "unknown-deviation" };
  const { key, choice, ...rest } = input;
  return changeColourSettings(db, { ...rest, change: (s) => withDeviationChoice(s, key, choice) });
}

/**
 * The colour setting a decision on a reviewed document imports with: the
 * map's (the review's target) when the document follows it — so a no-op
 * override the report cannot show is kept (row I7) — else the document's
 * own, read from its report.
 */
async function reviewedColourSettings(db: Db, doc: { hash: string; sourceHash: string; report: Prisma.JsonValue }, target: ReviewTarget | null): Promise<MapColourSettings> {
  const own = colourSettingsOfReport(doc.report);
  const colourTarget = target ? await colourTargetOf(db, target, doc.sourceHash) : null;
  if (!colourTarget) return own;
  const setting = await loadColourSettings(db, colourTarget);
  const recorded = (await loadRecordedColours(db, [doc.hash])).get(doc.hash);
  return documentFollowsColour({ report: doc.report, recorded }, setting) ? setting : own;
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
export async function decideOnDocument(db: PrismaClient, input: { hash: string; decisions: readonly ReviewDecision[]; userId: string | null; holdMs?: number; target?: ReviewTarget | null }): Promise<DecideResult> {
  const doc = await db.mapDocument.findUnique({ where: { hash: input.hash }, select: { sourceHash: true, patch: true, report: true } });
  const header = doc ? (await readDocumentHead(db, input.hash))?.header : null;
  if (!doc || !header) return { ok: false, reason: "not-found" };
  const writes = planDecisionWrites(header, input.decisions);
  await writeDecisions(db, writes, input.userId);
  // The reviewed document's corrections and colour setting come along (docs/map-patches.md §5 answer 1;
  // docs/map-symbols.md §9.3 "Per map (row I6)"): a job without a target has no map to read the setting from.
  const job = await startImportJob(db, { sourceHash: doc.sourceHash, startedBy: input.userId, holdMs: input.holdMs, patch: mapDocument.parseVersionPatch(doc.patch), colour: await reviewedColourSettings(db, { hash: input.hash, ...doc }, input.target ?? null) });
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
