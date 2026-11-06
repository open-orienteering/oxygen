/**
 * The Demo Competition's map on the document pipeline (docs/demo.md,
 * docs/map-storage.md): the generated synthetic OCAD becomes a
 * `map_sources` row, its imported document a `map_documents` row, and the
 * event's `map_files` row pins both with the quick-access columns the
 * import job's pin writes (`scale`, `bounds`, `north_offset`,
 * `calibration`).
 *
 * The rows come from the same code path as the API's import worker
 * (`importMapToDocument` + `buildImportReport`) and the pin
 * (`mapFileMetadataFor`), so a fixture loaded with `load-showcase.sh`
 * needs no re-match. Output is deterministic: the report's WMM date is
 * fixed and its timings are zeroed, so regenerating with no code change is
 * byte-identical. When the importer or the symbol library changes, the
 * document hash does too and `scripts/__tests__/showcase-map.test.mjs`
 * fails until `node scripts/patch-showcase-map.mjs` re-pins the fixture.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { SHOWCASE_OCAD, assertShowcaseOcadClean, buildShowcaseOcad } from "./ocad-fixture.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const API_SRC = path.join(ROOT, "packages", "api", "src");

/** Dates the report's WMM fields (`north.declinationDeg`); fixed for byte-identical output. */
export const SHOWCASE_REPORT_AS_OF = new Date("2026-01-01T00:00:00.000Z");

async function importApi() {
  return Promise.all([
    import(path.join(API_SRC, "import", "ocad.ts")),
    import(path.join(API_SRC, "map-store", "documents.ts")),
    import(path.join(API_SRC, "map-store", "map-file-metadata.ts")),
    import(path.join(API_SRC, "map-store", "event-document.ts")),
    import(path.join(ROOT, "packages", "shared", "src", "index.ts")),
  ]).then(([ocad, documents, metadata, eventDocument, shared]) => ({ ocad, documents, metadata, eventDocument, shared }));
}

let loaded;
/** Under `tsx` (the anonymiser) the TypeScript sources import as they are; under plain `node` register tsx's loader first. */
async function loadApi() {
  if (!loaded) {
    if (!process.execArgv.some((a) => a.includes("tsx"))) (await import("tsx/esm/api")).register();
    loaded = importApi();
  }
  return loaded;
}

/**
 * Import the synthetic showcase OCAD and return the three row shapes.
 *
 * @param {{ rotationCorrection?: number }} [opts] the `map_files.rotation_correction` the pin's columns are computed under (default 0)
 */
export async function buildShowcaseMapRows(opts = {}) {
  const { ocad, documents, metadata, eventDocument, shared } = await loadApi();
  const rotationCorrection = opts.rotationCorrection ?? 0;
  const file = buildShowcaseOcad();
  assertShowcaseOcadClean(file);

  const result = await ocad.importMapToDocument(file, SHOWCASE_OCAD.fileName, "ocad");
  result.timings = { read: 0, normalise: 0, match: 0, encode: 0 };
  const { header } = shared.mapDocument.readMapDocumentHeader(result.bytes);
  const report = documents.buildImportReport(result, header, SHOWCASE_OCAD.fileName, SHOWCASE_REPORT_AS_OF);
  const summary = documents.documentHeaderSummary(header);

  const frame = metadata.documentFrameSchema.parse(summary);
  const tilt = eventDocument.reportNorth(report)?.meridian?.medianTiltDeg ?? null;
  const columns = metadata.mapFileMetadataFor(frame, tilt, rotationCorrection);
  if (!columns) throw new Error("The showcase map's CRS does not project; the pin columns cannot be computed");

  return {
    source: {
      fileHash: result.fileHash,
      kind: "ocad",
      bytes: file,
      sizeBytes: file.byteLength,
      fileName: SHOWCASE_OCAD.fileName,
    },
    document: {
      hash: result.documentHash,
      bytes: Buffer.from(result.bytes),
      sizeBytes: result.bytes.byteLength,
      formatVersion: header.format.version,
      importerVersion: header.format.importer,
      libraryVersion: result.libraryVersion,
      sourceHash: result.fileHash,
      header: summary,
      report,
    },
    pin: {
      sourceHash: result.fileHash,
      documentHash: result.documentHash,
      rotationCorrection,
      scale: columns.scale,
      bounds: columns.bounds,
      northOffset: columns.northOffset,
      calibration: columns.calibration,
    },
  };
}
