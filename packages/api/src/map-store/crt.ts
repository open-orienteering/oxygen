/**
 * CRT export / import of club symbol decisions (docs/map-symbols.md §8.6,
 * docs/map-import.md §2.2; research 06 §5.1, §5.3). The codec is shared
 * (`mapImport.parseCrt` / `formatCrt` / `resolveCrt`); here the rows are
 * read, and an import is recorded through `decideOnDocument` — the same
 * path as `mapImport.decide`, which alone writes `club_symbol_decisions`.
 */

import { mapImport, symbolLibrary, type mapDocument } from "@oxygen/shared";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { DecisionInputError, loadClubDecisions, MAX_REVIEW_DECISIONS } from "./decisions.js";
import type { ImportJobRow } from "./jobs.js";
import { readDocumentHeader } from "./previews.js";
import { decideOnDocument } from "./review.js";

type Db = PrismaClient | Prisma.TransactionClient;

export const MAX_CRT_BYTES = 1024 * 1024;

/** `<source file name without extension>-<library id>.crt`, Mapper's `SOURCE-TARGET.crt` convention. */
export function crtFileName(sourceFileName: string, libraryId: string): string {
  const base = sourceFileName.split(/[\\/]/).pop() ?? "";
  const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  return `${stem || "map"}-${libraryId}.crt`;
}

export interface CrtExportResult {
  documentHash: string;
  fileName: string;
  library: { id: string; version: string };
  crt: string;
  rules: number;
  kept: number;
  auto: number;
}

/** The document's club decisions as a CRT, or `null` when there is no such document. */
export async function exportDocumentCrt(db: Db, hash: string, opts: { includeMatches?: boolean } = {}): Promise<CrtExportResult | null> {
  const doc = await db.mapDocument.findUnique({ where: { hash }, select: { source: { select: { kind: true, fileName: true } } } });
  const header = doc ? await readDocumentHeader(db, hash) : null;
  if (!doc || !header) return null;
  const out = mapImport.formatCrt(header, { decisions: await loadClubDecisions(db, doc.source.kind), documentHash: hash, includeMatches: opts.includeMatches });
  const libraryId = mapImport.documentLibraryId(header);
  return {
    documentHash: hash,
    fileName: crtFileName(doc.source.fileName, libraryId),
    library: { id: libraryId, version: symbolLibrary.SYMBOL_LIBRARY_VERSION },
    crt: out.text,
    rules: out.rules,
    kept: out.kept,
    auto: out.auto,
  };
}

/** Parse and resolve a CRT against a header; throws `DecisionInputError` past decide's cap. */
export function planCrtImport(header: mapImport.CrtDocumentLike, crt: string): mapImport.CrtResolution {
  const plan = mapImport.resolveCrt(mapImport.parseCrt(crt), header);
  if (plan.decisions.length > MAX_REVIEW_DECISIONS) throw new DecisionInputError(`${plan.decisions.length} decisions; at most ${MAX_REVIEW_DECISIONS} per import`);
  return plan;
}

export type CrtImportResult =
  | ({ ok: true; applied: number; job: ImportJobRow | null } & mapImport.CrtResolution)
  | { ok: false; reason: "not-found" };

/**
 * Resolve a CRT against the document and record what applies as `decide`
 * would. Nothing applicable, or `dryRun`, writes nothing and starts no job.
 */
export async function importDocumentCrt(db: PrismaClient, input: { hash: string; crt: string; userId: string | null; dryRun?: boolean; holdMs?: number }): Promise<CrtImportResult> {
  const header: mapDocument.MapDocumentHeader | null = await readDocumentHeader(db, input.hash);
  if (!header) return { ok: false, reason: "not-found" };
  const plan = planCrtImport(header, input.crt);
  if (input.dryRun || plan.decisions.length === 0) return { ok: true, ...plan, applied: 0, job: null };
  const res = await decideOnDocument(db, { hash: input.hash, decisions: plan.decisions, userId: input.userId, holdMs: input.holdMs });
  if (!res.ok) return res;
  return { ok: true, ...plan, applied: res.applied, job: res.job };
}
