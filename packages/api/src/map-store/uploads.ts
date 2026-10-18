/**
 * Chunked map upload — the pure half (docs/map-storage.md §5; research
 * 07 §7). Validation and assembly rules live here so they are unit-
 * testable; `upload-routes.ts` binds them to Fastify and Prisma.
 */

import { createHash } from "node:crypto";

export const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
/** Route body limit for one chunk: the chunk plus framing slack. */
export const CHUNK_BODY_LIMIT = MAX_CHUNK_BYTES + 64 * 1024;

export type MapSourceKind = "ocad" | "omap";

export interface UploadInit {
  fileName: string;
  bytes: number;
  chunkBytes: number;
}

export type UploadInitCheck =
  | { ok: true; chunkCount: number }
  | { ok: false; status: 400 | 413; error: string };

export function validateUploadInit(input: Partial<UploadInit> | null | undefined): UploadInitCheck {
  if (!input || typeof input !== "object") return { ok: false, status: 400, error: "Body must be { fileName, bytes, chunkBytes }" };
  const { fileName, bytes, chunkBytes } = input;
  if (typeof fileName !== "string" || fileName.trim().length === 0 || fileName.length > 512) {
    return { ok: false, status: 400, error: "fileName is required" };
  }
  if (!Number.isInteger(bytes) || (bytes as number) <= 0) return { ok: false, status: 400, error: "bytes must be a positive integer" };
  if ((bytes as number) > MAX_UPLOAD_BYTES) return { ok: false, status: 413, error: `File exceeds ${MAX_UPLOAD_BYTES} bytes` };
  if (!Number.isInteger(chunkBytes) || (chunkBytes as number) <= 0 || (chunkBytes as number) > MAX_CHUNK_BYTES) {
    return { ok: false, status: 400, error: `chunkBytes must be an integer in 1..${MAX_CHUNK_BYTES}` };
  }
  return { ok: true, chunkCount: chunkCount(bytes as number, chunkBytes as number) };
}

export function chunkCount(bytes: number, chunkBytes: number): number {
  return Math.ceil(bytes / chunkBytes);
}

/** Every chunk is `chunkBytes` long except the last, which carries the remainder. */
export function expectedChunkSize(n: number, bytes: number, chunkBytes: number): number | null {
  const count = chunkCount(bytes, chunkBytes);
  if (!Number.isInteger(n) || n < 0 || n >= count) return null;
  return n === count - 1 ? bytes - chunkBytes * (count - 1) : chunkBytes;
}

/**
 * Kind from the leading bytes: OCAD files start with the little-endian
 * magic 0x0CAD; Mapper files are XML with a `<map` root in the
 * OpenOrienteering namespace. Anything else is not a map we import.
 */
export function sniffMapKind(head: Uint8Array): MapSourceKind | null {
  if (head.length >= 2 && head[0] === 0xad && head[1] === 0x0c) return "ocad";
  // Optional UTF-8 BOM, then the XML prolog; the root must be a Mapper <map>.
  const start = head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  const text = Buffer.from(head.subarray(start, Math.min(head.length, start + 1024))).toString("latin1");
  if (/^\s*<\?xml/.test(text) && /<map\b/.test(text) && /openorienteering/i.test(text)) return "omap";
  return null;
}

/** Kinds the importer can process; others are refused at upload (415). */
export const IMPORTABLE_KINDS: ReadonlySet<MapSourceKind> = new Set<MapSourceKind>(["ocad", "omap"]);

/** Which chunk indices of `count` are absent from `present`. */
export function missingChunks(count: number, present: Iterable<number>): number[] {
  const have = new Set(present);
  const missing: number[] = [];
  for (let n = 0; n < count; n++) if (!have.has(n)) missing.push(n);
  return missing;
}

/** Concatenate ordered chunks and hash them in one pass. */
export function assembleChunks(chunks: Uint8Array[]): { bytes: Buffer; fileHash: string } {
  const hash = createHash("sha256");
  for (const c of chunks) hash.update(c);
  return { bytes: Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))), fileHash: hash.digest("hex") };
}
