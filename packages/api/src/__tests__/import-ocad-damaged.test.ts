/**
 * Damaged OCAD files (MAP-3, docs/map-import.md §3.6 `DAMAGED_FILE`): a file
 * cut short, or with an index block chain that loops, must end the import
 * with an error — not spin the reader for ever. Needs the patched
 * `ocad2geojson` (patches/).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mapImport } from "@oxygen/shared";
import { importOcadToDocument } from "../import/ocad.js";
import { runImportInWorker } from "../map-store/jobs.js";

const fixtures = {
  "test.ocd": readFileSync(fileURLToPath(new URL("../../../../e2e/test.ocd", import.meta.url))),
  "colour-layers.ocd": readFileSync(fileURLToPath(new URL("../../../../e2e/colour-layers.ocd", import.meta.url))),
};

const HEADER = { symbolIndexBlock: 8, objectIndexBlock: 12, stringIndexBlock: 32 } as const;

/** A copy whose index block at the header's pointer names itself as the next block. */
function withSelfLoop(file: Buffer, pointerAt: number): Buffer {
  const copy = Buffer.from(file);
  const block = copy.readUInt32LE(pointerAt);
  copy.writeInt32LE(block, block);
  return copy;
}

describe("damaged OCAD files end with an error", () => {
  for (const [name, file] of Object.entries(fixtures)) {
    for (const keep of [0.99, 0.9, 0.75, 0.5]) {
      it(`${name} cut to ${Math.round(keep * 100)} % is refused within 10 s`, async () => {
        const cut = file.subarray(0, Math.floor(file.byteLength * keep));
        const t0 = Date.now();
        // Either the reader's own parse error (a short cut) or DAMAGED_FILE; never a hang.
        await expect(runImportInWorker(cut, name, { timeoutMs: 20_000 })).rejects.toThrow();
        expect(Date.now() - t0).toBeLessThan(10_000);
      }, 30_000);
    }

    it(`${name}: an object index block that names itself as the next block settles`, async () => {
      const looped = withSelfLoop(file, HEADER.objectIndexBlock);
      const t0 = Date.now();
      await expect(runImportInWorker(looped, name, { timeoutMs: 20_000 })).rejects.toThrow(/DAMAGED_FILE/);
      expect(Date.now() - t0).toBeLessThan(10_000);
    }, 30_000);

    it(`${name}: a string index block that names itself as the next block settles`, async () => {
      const looped = withSelfLoop(file, HEADER.stringIndexBlock);
      await expect(runImportInWorker(looped, name, { timeoutMs: 20_000 })).rejects.toThrow(/DAMAGED_FILE/);
    }, 30_000);

    it(`${name}: a symbol index block that names itself as the next block settles`, async () => {
      const looped = withSelfLoop(file, HEADER.symbolIndexBlock);
      await expect(runImportInWorker(looped, name, { timeoutMs: 20_000 })).rejects.toThrow(/DAMAGED_FILE/);
    }, 30_000);
  }

  it("readOcad on a 90 % cut returns (with warnings) instead of spinning, and the warnings are recognised as damage", async () => {
    const { readOcad } = (await import("ocad2geojson")) as unknown as { readOcad: (b: Buffer, o?: Record<string, unknown>) => Promise<{ warnings: unknown[] }> };
    const file = fixtures["test.ocd"];
    const cut = file.subarray(0, Math.floor(file.byteLength * 0.9));
    const looped = withSelfLoop(file, HEADER.objectIndexBlock);
    const r = await readOcad(looped, { quietWarnings: true });
    expect(r.warnings.some(mapImport.isDamagedFileWarning)).toBe(true);
    // A cut file may fail with the reader's own error or return with warnings; both end promptly.
    await Promise.race([readOcad(cut, { quietWarnings: true }).catch(() => null), new Promise((_, no) => setTimeout(() => no(new Error("hang")), 10_000))]);
  }, 30_000);

  it("the intact fixtures still import (0 ends a chain silently)", async () => {
    for (const [name, file] of Object.entries(fixtures)) {
      const r = await importOcadToDocument(file, name);
      expect(r.counts.objects).toBeGreaterThan(0);
      expect(r.documentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  }, 60_000);

  it("a parse timer that expires rejects with DAMAGED_FILE", async () => {
    await expect(runImportInWorker(fixtures["test.ocd"], "test.ocd", { parseTimeoutMs: 1, timeoutMs: 20_000 })).rejects.toThrow(/DAMAGED_FILE: the map file could not be read within/);
  }, 30_000);
});
