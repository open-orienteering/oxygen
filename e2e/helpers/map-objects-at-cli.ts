/**
 * The objects of an event's pinned map document near a paper point, for the
 * patch E2E (docs/map-rendering.md §5.2 "Patch"): which `sourceIndex` to
 * hide, which symbol to add with. Run with tsx through
 * `event-map-pin.ts` `mapObjectsAt` (the shared package is ESM source,
 * which Playwright's test transform cannot load).
 *
 *   tsx e2e/helpers/map-objects-at-cli.ts <nameId> <xMm> <yMm> <radiusMm>
 *
 * Prints JSON `{ unitsPerMm, objects: [{ sourceIndex, symbolIdx, type, distanceMm }] }`,
 * nearest first: point, line and area objects of visible symbols whose
 * point, polyline (through every stored coordinate) or area outline is
 * within the radius.
 */
import { mapDocument } from "../../packages/shared/src/index.js";
import { newPrisma } from "../seed-builder/shared.js";

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

async function main() {
  const [nameId, xs, ys, rs] = process.argv.slice(2);
  if (!nameId || xs === undefined || ys === undefined || rs === undefined) throw new Error("usage: map-objects-at-cli.ts <nameId> <xMm> <yMm> <radiusMm>");
  const db = newPrisma();
  try {
    const event = await db.event.findFirstOrThrow({ where: { nameId }, select: { id: true } });
    const file = await db.mapFile.findFirstOrThrow({ where: { eventId: event.id }, orderBy: { uploadedAt: "desc" }, select: { documentHash: true } });
    if (!file.documentHash) throw new Error(`${nameId}: the map has no pinned document`);
    const { bytes } = await db.mapDocument.findUniqueOrThrow({ where: { hash: file.documentHash }, select: { bytes: true } });
    const doc = mapDocument.decodeMapDocument(bytes);
    const u = doc.header.unitsPerMm;
    const x = Number(xs) * u, y = Number(ys) * u, r = Number(rs) * u;
    const T = mapDocument.OBJECT_TYPE;
    const out: { sourceIndex: number; symbolIdx: number; type: number; distanceMm: number }[] = [];
    for (let i = 0; i < doc.header.objects.count; i++) {
      const type = doc.attrs.type[i];
      if (type !== T.point && type !== T.line && type !== T.area) continue;
      if (doc.header.symbols[doc.attrs.symbolIdx[i]]?.hidden) continue;
      if (x < doc.bboxes[i * 4] - r || x > doc.bboxes[i * 4 + 2] + r || y < doc.bboxes[i * 4 + 1] - r || y > doc.bboxes[i * 4 + 3] + r) continue;
      const from = doc.coordStart[i], to = doc.coordStart[i + 1];
      const c = (k: number) => [doc.coords[k * 2], doc.coords[k * 2 + 1]] as const;
      let d = Infinity;
      if (type === T.point || to - from === 1) d = Math.hypot(x - c(from)[0], y - c(from)[1]);
      else {
        for (let k = from; k + 1 < to; k++) d = Math.min(d, segmentDistance(x, y, ...c(k), ...c(k + 1)));
        if (type === T.area) d = Math.min(d, segmentDistance(x, y, ...c(to - 1), ...c(from)));
      }
      if (d <= r) out.push({ sourceIndex: doc.attrs.sourceIndex[i], symbolIdx: doc.attrs.symbolIdx[i], type, distanceMm: d / u });
    }
    out.sort((a, b) => a.distanceMm - b.distanceMm);
    process.stdout.write(`${JSON.stringify({ unitsPerMm: u, objects: out })}\n`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
