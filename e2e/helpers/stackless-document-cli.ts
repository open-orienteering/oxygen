/**
 * Pin a copy of an event's map document whose colour stack is not aligned
 * (`CourseStackError`: no lower / upper purple), for the viewer's notice
 * (docs/map-rendering.md §5.4 "Fallback"). Run with tsx from
 * `e2e/helpers/stackless-document.ts` (the shared package is ESM source,
 * which Playwright's test transform cannot load). Prints the hash it
 * replaced and the copy's, so the caller can pin the original back and
 * delete the copy.
 *
 *   tsx e2e/helpers/stackless-document-cli.ts <nameId>
 *
 * The copy is the document with its palette ids stripped and a single
 * object (as `print-worker.test.ts` builds one); its hash is the SHA-256 of
 * its bytes. The row has a source of its own and the original's report.
 */
import { createHash } from "node:crypto";
import { mapDocument } from "../../packages/shared/src/index.js";
import { newPrisma } from "../seed-builder/shared.js";

async function main() {
  const nameId = process.argv[2];
  if (!nameId) throw new Error("usage: stackless-document-cli.ts <nameId>");
  const db = newPrisma();
  try {
    const event = await db.event.findFirstOrThrow({ where: { nameId }, select: { id: true } });
    const file = await db.mapFile.findFirstOrThrow({ where: { eventId: event.id }, orderBy: { uploadedAt: "desc" }, select: { id: true, documentHash: true } });
    if (!file.documentHash) throw new Error(`${nameId}: the map has no pinned document`);
    const original = await db.mapDocument.findUniqueOrThrow({ where: { hash: file.documentHash } });
    const { header: h } = mapDocument.decodeMapDocument(original.bytes);
    const { bounds: _b, strings: _s, objects: _o, ...rest } = h as unknown as Record<string, unknown>;
    const bytes = mapDocument.encodeMapDocument({
      header: { ...rest, colours: h.colours.map((c: object) => ({ ...c, paletteIds: undefined })) } as never,
      objects: [{ symbolIdx: 0, type: 1, sourceIndex: 0, coords: [0, 0], flags: [0] }],
    });
    const hash = createHash("sha256").update(bytes).digest("hex");
    const { header } = mapDocument.readMapDocumentHeader(bytes);
    // As `documentHeaderSummary` (map-store/documents.ts) stores it.
    const { symbols, strings, ...rest2 } = header;
    const summary = { ...rest2, symbolCount: symbols.length, stringCount: strings.length };
    // A source of its own: sharing the original's would let a later upload of
    // the same file be matched to this copy if a run stopped before restoring.
    const sourceBytes = new TextEncoder().encode(`stackless copy of ${file.documentHash}`);
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    await db.mapSource.createMany({
      data: [{ fileHash: sourceHash, kind: "ocad", bytes: Uint8Array.from(sourceBytes), sizeBytes: sourceBytes.byteLength, fileName: "stackless.ocd" }],
      skipDuplicates: true,
    });
    await db.mapDocument.createMany({
      data: [{
        hash,
        bytes: Uint8Array.from(bytes),
        sizeBytes: bytes.byteLength,
        formatVersion: original.formatVersion,
        importerVersion: original.importerVersion,
        libraryVersion: original.libraryVersion,
        sourceHash,
        header: summary as never,
        report: original.report as never,
      }],
      skipDuplicates: true,
    });
    await db.mapFile.update({ where: { id: file.id }, data: { documentHash: hash } });
    process.stdout.write(`${file.documentHash} ${hash}\n`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
