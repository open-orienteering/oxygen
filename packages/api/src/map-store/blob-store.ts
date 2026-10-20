/**
 * Content-addressed blob access (docs/map-storage.md §2). The seam that
 * keeps object storage possible: routes and the import job only ever call
 * these three functions over the two blob tables. Today they are Postgres
 * `bytea` columns with STORAGE EXTERNAL, so a byte range is one
 * `substring()` that touches only the covering TOAST chunks.
 */

import type { PrismaClient, Prisma } from "../generated/prisma/client.js";

type Db = PrismaClient | Prisma.TransactionClient;

export type BlobTable = "map_sources" | "map_documents";

const KEY_COLUMN: Record<BlobTable, string> = { map_sources: "file_hash", map_documents: "hash" };

export interface BlobRange {
  /** First byte, inclusive, 0-based. */
  start: number;
  /** Last byte, inclusive. */
  end: number;
}

/** Whole blob, or the bytes of `range`. `null` when the row does not exist. */
export async function getBlob(db: Db, table: BlobTable, hash: string, range?: BlobRange): Promise<Buffer | null> {
  const key = KEY_COLUMN[table];
  const rows = range
    ? await db.$queryRawUnsafe<{ chunk: Buffer }[]>(
        `SELECT substring(bytes FROM $1 FOR $2) AS chunk FROM oxygen.${table} WHERE ${key} = $3`,
        range.start + 1,
        range.end - range.start + 1,
        hash,
      )
    : await db.$queryRawUnsafe<{ chunk: Buffer }[]>(`SELECT bytes AS chunk FROM oxygen.${table} WHERE ${key} = $1`, hash);
  const row = rows[0];
  return row ? Buffer.from(row.chunk) : null;
}

/** Size without touching the blob (`size_bytes` is stored alongside). */
export async function getBlobSize(db: Db, table: BlobTable, hash: string): Promise<number | null> {
  const key = KEY_COLUMN[table];
  const rows = await db.$queryRawUnsafe<{ size_bytes: number }[]>(`SELECT size_bytes FROM oxygen.${table} WHERE ${key} = $1`, hash);
  return rows[0]?.size_bytes ?? null;
}

/**
 * Delete a blob row. Fails (FK RESTRICT) while anything references it;
 * only the GC job calls this, after the reference check.
 */
export async function deleteBlob(db: Db, table: BlobTable, hash: string): Promise<boolean> {
  const key = KEY_COLUMN[table];
  const n = await db.$executeRawUnsafe(`DELETE FROM oxygen.${table} WHERE ${key} = $1`, hash);
  return n > 0;
}
