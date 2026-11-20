/**
 * Re-match pass over stored documents (docs/map-storage.md §6.9; research
 * 03 §6.5, 09 slice A). This pass revisits pins whose document is not what
 * the source imports to now and runs an ordinary import job for each, so
 * the pin follows the fresh document:
 *
 *   club_map_versions  stale importer, library release, club decisions or
 *                      the series' colour setting
 *   map_files          stale importer, library release or the event's
 *                      colour setting only — an event
 *                      keeps the document it pinned when only decisions
 *                      changed (06 §6 copy-on-use; `finalise` moves it) —
 *                      and a live event's row with a source but no
 *                      document at all (an import that failed or never
 *                      ran, a restored pre-v0.6.1 dump; the job the
 *                      retired backfill ran, §6.7)
 *
 * A document is judged once per run whatever pins it. Every item is
 * keyed by content hash, so a re-run finds only what is still stale.
 *
 * Each item's pin re-keys the event's map patch (`applyJobResult`); the
 * pass ends with a sweep that re-keys every live event's patch still
 * keyed to another document than its pin (docs/map-patches.md §4.4).
 */

import { mapDocument, symbolLibrary } from "@oxygen/shared";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { IMPORTER_VERSIONS } from "../import/ocad.js";
import { loadClubDecisions, storedDocumentFollowsDecisions } from "./decisions.js";
import { eventDocumentHash } from "./event-document.js";
import { awaitImportJob, startImportJob, type ImportJobRow } from "./jobs.js";
import { reresolveEventPatch } from "./patches.js";
import { colourTargetKey, DEFAULT_COLOUR_SETTINGS, documentFollowsColour, loadAllColourSettings, loadRecordedColours, type ColourTarget } from "./colour-settings.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** `patch`: an event's map patch keyed to another document than its pin (the sweep, docs/map-patches.md §4.4). */
/** `colour`: the pin's document is not in its map's colour setting (docs/map-symbols.md §9.3 "Per map (row I6)"). */
export type RematchReason = "importer" | "library" | "decisions" | "colour" | "unpinned" | "patch";

export interface RematchItem {
  kind: "club" | "event" | "patch";
  /** `club_map_versions.id`, or the event id for an event's pins of one source or its patch. */
  id: string;
  name: string;
  /** The pin's source; empty for a `patch` item. */
  sourceHash: string;
  /** The stale document (a `patch` item: the one the patch is keyed onto); null for an `unpinned` row. */
  documentHash: string | null;
  reason: RematchReason;
  /**
   * The corrections the re-import bakes (docs/map-patches.md §5 answer 1): a club item's version patch, an event
   * item's from the document it replaces, an `unpinned` row's from its club version; absent = none.
   */
  patch?: mapDocument.VersionPatch;
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

/** Why a document is stale, or `null` when importing its source now reproduces it; importer, library, decisions, colour in that order. */
export function staleReason(doc: { importerVersion: string; libraryVersion: string }, followsDecisions: boolean, followsColour = true): RematchReason | null {
  if (!(IMPORTER_VERSIONS as readonly string[]).includes(doc.importerVersion)) return "importer";
  if (!doc.libraryVersion.endsWith(`@${symbolLibrary.SYMBOL_LIBRARY_VERSION}`)) return "library";
  if (!followsDecisions) return "decisions";
  return followsColour ? null : "colour";
}

/** Pins whose document is stale, club versions first, oldest first; then live events' sourced rows without a document. */
export async function planRematch(db: Db, opts: Pick<RematchOptions, "eventId" | "limit"> = {}): Promise<RematchItem[]> {
  const versions = opts.eventId
    ? []
    : await db.clubMapVersion.findMany({
        orderBy: [{ uploadedAt: "asc" }, { id: "asc" }],
        select: { id: true, clubMapId: true, sourceHash: true, documentHash: true, label: true, patch: true, clubMap: { select: { name: true } } },
      });
  const files = await db.mapFile.findMany({
    where: { documentHash: { not: null }, sourceHash: { not: null }, event: { removed: false }, ...(opts.eventId ? { eventId: opts.eventId } : {}) },
    orderBy: [{ eventId: "asc" }, { id: "asc" }],
    select: { eventId: true, sourceHash: true, documentHash: true, event: { select: { name: true, nameId: true } } },
  });

  const hashes = [...new Set([...versions.map((v) => v.documentHash), ...files.map((f) => f.documentHash!)])];
  const docs = await db.mapDocument.findMany({
    where: { hash: { in: hashes } },
    select: { hash: true, importerVersion: true, libraryVersion: true, report: true, patch: true, source: { select: { kind: true } } },
  });
  const patchOf = new Map(docs.map((d) => [d.hash, mapDocument.parseVersionPatch(d.patch)]));
  const withPatch = (patch: mapDocument.VersionPatch | undefined) => (patch && patch.length ? { patch } : {});
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
  // The colour setting is the map's, not the document's: judged per pin (§6.9).
  const reportOf = new Map(docs.map((d) => [d.hash, d.report]));
  const settings = await loadAllColourSettings(db);
  const colourOf = (target: ColourTarget) => settings.get(colourTargetKey(target)) ?? DEFAULT_COLOUR_SETTINGS;
  // A document follows a setting by its report or by a setting recorded for it (row I7: an override that changes no bytes).
  const recorded = await loadRecordedColours(db, docs.map((d) => d.hash));
  const followsColour = (hash: string, target: ColourTarget) => documentFollowsColour({ report: reportOf.get(hash), recorded: recorded.get(hash) }, colourOf(target));

  const items: RematchItem[] = [];
  for (const v of versions) {
    const reason = reasons.get(v.documentHash) ?? (followsColour(v.documentHash, { kind: "club", clubMapId: v.clubMapId }) ? null : "colour");
    if (reason) items.push({ kind: "club", id: v.id, name: `${v.clubMap.name} (${v.label})`, sourceHash: v.sourceHash, documentHash: v.documentHash, reason, ...withPatch(mapDocument.parseVersionPatch(v.patch)) });
  }
  const seen = new Set<string>();
  for (const f of files) {
    const docReason = reasons.get(f.documentHash!) ?? null;
    // Only technical staleness moves an event's pin (copy-on-use), and the event's own colour setting.
    const reason = docReason && docReason !== "decisions"
      ? docReason
      : followsColour(f.documentHash!, { kind: "event", eventId: f.eventId, sourceHash: f.sourceHash! }) ? null : "colour";
    if (!reason) continue;
    const key = `${f.eventId}|${f.sourceHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kind: "event", id: String(f.eventId), name: f.event.name || f.event.nameId, sourceHash: f.sourceHash!, documentHash: f.documentHash!, reason, ...withPatch(patchOf.get(f.documentHash!)) });
  }
  const unpinned = await db.mapFile.findMany({
    where: { documentHash: null, sourceHash: { not: null }, event: { removed: false }, ...(opts.eventId ? { eventId: opts.eventId } : {}) },
    orderBy: [{ eventId: "asc" }, { id: "asc" }],
    select: { eventId: true, sourceHash: true, event: { select: { name: true, nameId: true } }, clubMapVersion: { select: { patch: true } } },
  });
  for (const f of unpinned) {
    const key = `${f.eventId}|${f.sourceHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kind: "event", id: String(f.eventId), name: f.event.name || f.event.nameId, sourceHash: f.sourceHash!, documentHash: null, reason: "unpinned", ...withPatch(mapDocument.parseVersionPatch(f.clubMapVersion?.patch)) });
  }
  return opts.limit ? items.slice(0, opts.limit) : items;
}

/** The sweep's items (§4.4): live events whose patch row is keyed to another document than their pin. */
export async function planPatchSweep(db: Db, opts: Pick<RematchOptions, "eventId"> = {}): Promise<RematchItem[]> {
  const rows = await db.mapPatch.findMany({
    where: { event: { removed: false }, ...(opts.eventId ? { eventId: opts.eventId } : {}) },
    orderBy: { eventId: "asc" },
    select: { eventId: true, documentHash: true, event: { select: { name: true, nameId: true } } },
  });
  const items: RematchItem[] = [];
  for (const r of rows) {
    const pin = await eventDocumentHash(db, r.eventId);
    if (pin && pin !== r.documentHash) items.push({ kind: "patch", id: String(r.eventId), name: r.event.name || r.event.nameId, sourceHash: "", documentHash: r.documentHash, reason: "patch" });
  }
  return items;
}

async function sweepItem(db: Db, item: RematchItem): Promise<Omit<RematchItemResult, keyof RematchItem>> {
  const r = await reresolveEventPatch(db, BigInt(item.id));
  if (r.outcome === "failed") return { outcome: "failed", jobId: null, newDocumentHash: null, error: r.error ?? "re-resolution failed" };
  return { outcome: "done", jobId: null, newDocumentHash: r.to ?? (await eventDocumentHash(db, BigInt(item.id))), error: null };
}

/** One pin's re-import (exported for the promote tests, which run their own items). */
export async function rematchItem(db: Db, item: RematchItem, timeoutMs?: number): Promise<Omit<RematchItemResult, keyof RematchItem>> {
  const target = item.kind === "club"
    ? { clubMapId: (await db.clubMapVersion.findUniqueOrThrow({ where: { id: item.id }, select: { clubMapId: true } })).clubMapId }
    : { eventId: BigInt(item.id) };
  let job: ImportJobRow | null = await startImportJob(db, { sourceHash: item.sourceHash, ...target, patch: item.patch ?? [], holdMs: 0 });
  if (job.state !== "done" && job.state !== "failed") job = await awaitImportJob(db, job.id, timeoutMs ? { timeoutMs } : {});
  if (job?.state === "done") return { outcome: "done", jobId: job.id, newDocumentHash: job.documentHash, error: null };
  const error = job?.state === "failed" ? (job.error ?? "import failed") : `import still ${job?.state ?? "missing"} when the wait ended`;
  return { outcome: "failed", jobId: job?.id ?? null, newDocumentHash: null, error };
}

/**
 * One pass, one map at a time; a failed item is reported, never an abort.
 * The patch sweep is planned after the pins ran (their pins re-key most
 * patches); a dry run lists the patches dormant now.
 */
export async function runRematch(db: Db, opts: RematchOptions = {}): Promise<RematchRun & { failures: RematchItemResult[] }> {
  const pins = await planRematch(db, opts);
  const items = opts.dryRun ? [...pins, ...(await planPatchSweep(db, opts))] : pins;
  const run: RematchRun & { failures: RematchItemResult[] } = { dryRun: !!opts.dryRun, total: items.length, processed: 0, done: 0, failed: 0, startedAt: new Date(), finishedAt: null, failures: [] };
  opts.onPlan?.(items);
  if (!run.dryRun) {
    const work = async function* () {
      yield* items;
      const sweep = await planPatchSweep(db, opts);
      run.total += sweep.length;
      yield* sweep;
    };
    for await (const item of work()) {
      let r: Omit<RematchItemResult, keyof RematchItem>;
      try {
        r = item.kind === "patch" ? await sweepItem(db, item) : await rematchItem(db, item, opts.itemTimeoutMs);
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
