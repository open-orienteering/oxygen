/**
 * A library entry materialised on an event's pinned map document, as the
 * patch stores it (docs/map-symbols.md §11.1; `materialiseSymbol`), for an
 * E2E that puts objects with it straight through `mapPatch.applyChange`
 * (G28's track lines). Run with tsx through `event-map-pin.ts`
 * `patchSymbolFor` (the shared package is ESM source, which Playwright's
 * test transform cannot load).
 *
 *   tsx e2e/helpers/patch-symbol-cli.ts <nameId> <entryId>
 *
 * Prints JSON `{ documentHash, key, symbol }`.
 */
import { mapDocument } from "../../packages/shared/src/index.js";
import { newPrisma } from "../seed-builder/shared.js";

async function main() {
  const [nameId, entryId] = process.argv.slice(2);
  if (!nameId || !entryId) throw new Error("usage: patch-symbol-cli.ts <nameId> <entryId>");
  const db = newPrisma();
  try {
    const event = await db.event.findFirstOrThrow({ where: { nameId }, select: { id: true } });
    const file = await db.mapFile.findFirstOrThrow({ where: { eventId: event.id }, orderBy: { uploadedAt: "desc" }, select: { documentHash: true } });
    if (!file.documentHash) throw new Error(`${nameId}: the map has no pinned document`);
    const { bytes } = await db.mapDocument.findUniqueOrThrow({ where: { hash: file.documentHash }, select: { bytes: true } });
    const r = mapDocument.materialiseSymbol(mapDocument.decodeMapDocument(bytes), entryId);
    if (!r.ok) throw new Error(`${entryId}: not materialisable (${r.reason})`);
    process.stdout.write(`${JSON.stringify({ documentHash: file.documentHash, key: r.key, symbol: r.symbol })}\n`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
