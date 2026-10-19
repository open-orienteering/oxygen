/**
 * Club symbol decisions (docs/map-symbols.md §8.5; research 06 §5.3,
 * 07 §4.3). `club_symbol_decisions` is written here and nowhere else —
 * only on behalf of `mapImport.decide` — and read when an import job is
 * inserted, as the job's `decisions` snapshot (docs/map-storage.md §6.1).
 */

import { z } from "zod";
import { mapImport, symbolLibrary, type mapDocument } from "@oxygen/shared";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { readDocumentHeader } from "./previews.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** The job column's element shape: `mapImport.SymbolDecision` as stage 6 takes it. */
export const symbolDecisionSchema = z.object({
  code: z.string(),
  name: z.string().optional(),
  irHash: z.string().optional(),
  canonicalId: z.string().nullable(),
  libraryId: z.string().optional(),
});
export const symbolDecisionsSchema = z.array(symbolDecisionSchema);

/** The job column read back; a malformed value (a hand-edited row) imports without decisions rather than failing the job. */
export function parseDecisionSnapshot(json: unknown): mapImport.SymbolDecision[] {
  const parsed = symbolDecisionsSchema.safeParse(json);
  return parsed.success ? parsed.data : [];
}

/** The most decisions one `decide` (or CRT import) records. */
export const MAX_REVIEW_DECISIONS = 5_000;

/** One review decision as `mapImport.decide` takes it (06 §5.1). */
export const reviewDecisionSchema = z.union([
  z.object({ symbolIdx: z.number().int().min(0), accept: z.string().min(1) }).strict(),
  z.object({ symbolIdx: z.number().int().min(0), unmatch: z.literal(true) }).strict(),
  z.object({ symbolIdx: z.number().int().min(0), reset: z.literal(true) }).strict(),
]);
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

export async function loadClubDecisionRows(db: Db): Promise<mapImport.ClubDecisionRow[]> {
  return db.clubSymbolDecision.findMany({
    select: { fingerprint: true, libraryVersion: true, canonicalId: true, decidedAt: true },
    orderBy: [{ fingerprint: "asc" }, { libraryVersion: "asc" }],
  });
}

/** The decisions stage 6 applies to a source of `kind` now. */
export async function loadClubDecisions(db: Db, kind: string): Promise<mapImport.SymbolDecision[]> {
  return mapImport.decisionsFromRows(await loadClubDecisionRows(db), kind);
}

/** A rejected decision list; the router answers `BAD_REQUEST` with the message. */
export class DecisionInputError extends Error {}

export type DecisionWrite =
  | { op: "set"; fingerprint: string; libraryVersion: string; canonicalId: string | null }
  | { op: "reset"; fingerprint: string; libraryId: string };

/**
 * Turn review decisions on a document into row writes, or throw
 * `DecisionInputError`. The library is the document's own (the scale's
 * for a pre-matcher document); an accepted id must be one of its entries.
 * A later decision on the same fingerprint in one list wins.
 */
export function planDecisionWrites(header: Pick<mapDocument.MapDocumentHeader, "source" | "colours" | "symbols" | "mapScale" | "library">, decisions: readonly ReviewDecision[]): DecisionWrite[] {
  const stored = header.library?.id;
  const libraryId = stored && symbolLibrary.isSymbolLibraryId(stored) ? stored : mapImport.chooseLibrary(header.mapScale);
  const libraryVersion = `${libraryId}@${symbolLibrary.SYMBOL_LIBRARY_VERSION}`;
  const fingerprints = mapImport.documentSymbolFingerprints(header);
  const writes = new Map<string, DecisionWrite>();
  for (const d of decisions) {
    const symbol = header.symbols[d.symbolIdx];
    if (!symbol) throw new DecisionInputError(`symbolIdx ${d.symbolIdx} is not a symbol of this document`);
    const fingerprint = fingerprints[d.symbolIdx];
    if (!fingerprint) throw new DecisionInputError(`symbol ${symbol.code} (${d.symbolIdx}) is not a reviewable source symbol`);
    if ("accept" in d) {
      const entry = symbolLibrary.getLibraryEntry(d.accept);
      if (!entry || !d.accept.startsWith(`${libraryId}:`)) throw new DecisionInputError(`${d.accept} is not an entry of ${libraryId}`);
      writes.set(fingerprint, { op: "set", fingerprint, libraryVersion, canonicalId: d.accept });
    } else if ("unmatch" in d) {
      writes.set(fingerprint, { op: "set", fingerprint, libraryVersion, canonicalId: null });
    } else {
      writes.set(fingerprint, { op: "reset", fingerprint, libraryId });
    }
  }
  return [...writes.values()];
}

/**
 * Apply the writes in one transaction. `set` upserts under the current
 * release and stamps `decided_at` (newest wins across releases);
 * `reset` deletes the fingerprint's rows of that library under every
 * release, so the matcher's proposal returns.
 */
export async function writeDecisions(db: PrismaClient, writes: readonly DecisionWrite[], decidedBy: string | null): Promise<void> {
  if (!writes.length) return;
  const now = new Date();
  await db.$transaction(
    writes.map((w) =>
      w.op === "set"
        ? db.clubSymbolDecision.upsert({
            where: { fingerprint_libraryVersion: { fingerprint: w.fingerprint, libraryVersion: w.libraryVersion } },
            create: { fingerprint: w.fingerprint, libraryVersion: w.libraryVersion, canonicalId: w.canonicalId, decidedBy, decidedAt: now },
            update: { canonicalId: w.canonicalId, decidedBy, decidedAt: now },
          })
        : db.clubSymbolDecision.deleteMany({ where: { fingerprint: w.fingerprint, libraryVersion: { startsWith: `${w.libraryId}@` } } }),
    ),
  );
}

/**
 * Whether a stored document is what importing its source with
 * `decisions` gives now (docs/map-symbols.md §8.5
 * `documentFollowsDecisions`). A report with no `explicit` matches and
 * no decisions to apply needs no header read.
 */
export async function storedDocumentFollowsDecisions(db: Db, doc: { hash: string; report: Prisma.JsonValue }, decisions: readonly mapImport.SymbolDecision[], known?: mapDocument.MapDocumentHeader): Promise<boolean> {
  const explicit = (doc.report as { matching?: { byMethod?: Record<string, number> } } | null)?.matching?.byMethod?.explicit ?? 0;
  if (decisions.length === 0 && explicit === 0) return true;
  const header = known ?? (await readDocumentHeader(db, doc.hash));
  return header !== null && mapImport.documentFollowsDecisions(header, decisions);
}
