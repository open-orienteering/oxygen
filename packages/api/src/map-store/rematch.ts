/**
 * Re-match pass over stored documents (docs/map-storage.md §6.9; research
 * 03 §6.5, 09 slice A). The backfill (§6.7) gives rows without a document
 * one; this pass revisits pins whose document is not what the source
 * imports to now and runs an ordinary import job for each, so the pin
 * follows the fresh document:
 *
 *   club_map_versions  stale importer, library release or club decisions
 *   map_files          stale importer or library release only — an event
 *                      keeps the document it pinned when only decisions
 *                      changed (06 §6 copy-on-use; `finalise` moves it)
 *
 * A document is judged once per run whatever pins it. Every item is
 * keyed by content hash, so a re-run finds only what is still stale.
 */

import { symbolLibrary } from "@oxygen/shared";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { IMPORTER_VERSIONS } from "../import/ocad.js";
import { loadClubDecisions, storedDocumentFollowsDecisions } from "./decisions.js";
import { awaitImportJob, startImportJob, type ImportJobRow } from "./jobs.js";

type Db = PrismaClient | Prisma.TransactionClient;

export type RematchReason = "importer" | "library" | "decisions";

export interface RematchItem {
  kind: "club" | "event";
  /** `club_map_versions.id`, or the event id for an event's pins of one source. */
  id: string;
  name: string;
  sourceHash: string;
  documentHash: string;
  reason: RematchReason;
}

export interface RematchItemResult extends RematchItem {
  outcome: "done" | "failed";
  jobId: string | null;
  newDocumentHash: string | null;
  error: string | null;
}

export interface RematchRun {
  dryRun: boolean;
  total: number;
  processed: number;
  done: number;
  failed: number;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface RematchOptions {
  eventId?: bigint | null;
  limit?: number;
  dryRun?: boolean;
  itemTimeoutMs?: number;
  onPlan?: (items: RematchItem[]) => void;
  onItem?: (result: RematchItemResult, run: RematchRun) => void;
}

/** Why a document is stale, or `null` when importing its source now reproduces it. */
export function staleReason(doc: { importerVersion: string; libraryVersion: string }, followsDecisions: boolean): RematchReason | null {
  if (!(IMPORTER_VERSIONS as readonly string[]).includes(doc.importerVersion)) return "importer";
  if (!doc.libraryVersion.endsWith(`@${symbolLibrary.SYMBOL_LIBRARY_VERSION}`)) return "library";
  return followsDecisions ? null : "decisions";
}

/** Pins whose document is stale, club versions first, oldest first. */
export async function planRematch(db: Db, opts: Pick<RematchOptions, "eventId" | "limit"> = {}): Promise<RematchItem[]> {
  const versions = opts.eventId
    ? []
    : await db.clubMapVersion.findMany({
        orderBy: [{ uploadedAt: "asc" }, { id: "asc" }],
        select: { id: true, sourceHash: true, documentHash: true, label: true, clubMap: { select: { name: true } } },
      });
  const files = await db.mapFile.findMany({
    where: { documentHash: { not: null }, sourceHash: { not: null }, event: { removed: false }, ...(opts.eventId ? { eventId: opts.eventId } : {}) },
    orderBy: [{ eventId: "asc" }, { id: "asc" }],
    select: { eventId: true, sourceHash: true, documentHash: true, event: { select: { name: true, nameId: true } } },
  });

  const hashes = [...new Set([...versions.map((v) => v.documentHash), ...files.map((f) => f.documentHash!)])];
  const docs = await db.mapDocument.findMany({
    where: { hash: { in: hashes } },
    select: { hash: true, importerVersion: true, libraryVersion: true, report: true, source: { select: { kind: true } } },
  });
  const decisionsByKind = new Map<string, Awaited<ReturnType<typeof loadClubDecisions>>>();
  const reasons = new Map<string, RematchReason | null>();
  for (const d of docs) {
    const technical = staleReason(d, true);
    if (technical) {
      reasons.set(d.hash, technical);
      continue;
    }
    let decisions = decisionsByKind.get(d.source.kind);
    if (!decisions) decisionsByKind.set(d.source.kind, (decisions = await loadClubDecisions(db, d.source.kind)));
    reasons.set(d.hash, (await storedDocumentFollowsDecisions(db, d, decisions)) ? null : "decisions");
  }

  const items: RematchItem[] = [];
  for (const v of versions) {
    const reason = reasons.get(v.documentHash) ?? null;
    if (reason) items.push({ kind: "club", id: v.id, name: `${v.clubMap.name} (${v.label})`, sourceHash: v.sourceHash, documentHash: v.documentHash, reason });
  }
  const seen = new Set<string>();
  for (const f of files) {
    const reason = reasons.get(f.documentHash!) ?? null;
    // Only technical staleness moves an event's pin (copy-on-use).
    if (!reason || reason === "decisions") continue;
    const key = `${f.eventId}|${f.sourceHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kind: "event", id: String(f.eventId), name: f.event.name || f.event.nameId, sourceHash: f.sourceHash!, documentHash: f.documentHash!, reason });
  }
  return opts.limit ? items.slice(0, opts.limit) : items;
}

async function rematchItem(db: Db, item: RematchItem, timeoutMs?: number): Promise<Omit<RematchItemResult, keyof RematchItem>> {
  const target = item.kind === "club"
    ? { clubMapId: (await db.clubMapVersion.findUniqueOrThrow({ where: { id: item.id }, select: { clubMapId: true } })).clubMapId }
    : { eventId: BigInt(item.id) };
  let job: ImportJobRow | null = await startImportJob(db, { sourceHash: item.sourceHash, ...target, holdMs: 0 });
  if (job.state !== "done" && job.state !== "failed") job = await awaitImportJob(db, job.id, timeoutMs ? { timeoutMs } : {});
  if (job?.state === "done") return { outcome: "done", jobId: job.id, newDocumentHash: job.documentHash, error: null };
  const error = job?.state === "failed" ? (job.error ?? "import failed") : `import still ${job?.state ?? "missing"} when the wait ended`;
  return { outcome: "failed", jobId: job?.id ?? null, newDocumentHash: null, error };
}

/** One pass, one map at a time; a failed item is reported, never an abort. */
export async function runRematch(db: Db, opts: RematchOptions = {}): Promise<RematchRun & { failures: RematchItemResult[] }> {
  const items = await planRematch(db, opts);
  const run: RematchRun & { failures: RematchItemResult[] } = { dryRun: !!opts.dryRun, total: items.length, processed: 0, done: 0, failed: 0, startedAt: new Date(), finishedAt: null, failures: [] };
  opts.onPlan?.(items);
  if (!run.dryRun) {
    for (const item of items) {
      let r: Omit<RematchItemResult, keyof RematchItem>;
      try {
        r = await rematchItem(db, item, opts.itemTimeoutMs);
      } catch (err: unknown) {
        r = { outcome: "failed", jobId: null, newDocumentHash: null, error: (err instanceof Error ? err.message : String(err)).slice(0, 2000) };
      }
      const result: RematchItemResult = { ...item, ...r };
      run.processed += 1;
      if (result.outcome === "done") run.done += 1;
      else {
        run.failed += 1;
        run.failures.push(result);
      }
      opts.onItem?.(result, run);
    }
  }
  run.finishedAt = new Date();
  return run;
}
