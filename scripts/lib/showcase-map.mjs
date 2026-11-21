/**
 * The Demo Competition's map (docs/ops/demo.md, "The map"): the o-kartan
 * map of a Swedish forest, bought for the project and licensed for any use
 * (docs/ops/demo-map.md), committed as bought (`okartan-original.ocd`) and
 * as the demo map made of it by `packages/api/scripts/demo-map/`
 * (`okartan-demo.ocd`, invented boulders, landforms and cliff tags added).
 *
 * The fixture holds only the demo map's source hash: `showcase.sql`
 * writes a `map_files` row with `source_hash` set and `document_hash`
 * NULL, `scripts/load-showcase.sh` inserts the `map_sources` row from the
 * committed file and runs the re-match, which imports the document and
 * pins it (docs/map-storage.md §6.9, `unpinned`). So the document is
 * always made by the importer of the image that serves it, and the
 * fixture never carries map bytes.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const API_SRC = path.join(ROOT, "packages", "api", "src");
const FIXTURES = path.join(ROOT, "fixtures", "okartan");

/** The map as bought from o-kartan.se. */
export const ORIGINAL_MAP_PATH = path.join(FIXTURES, "okartan-original.ocd");
/** The demo map: the original plus the invented detail (docs/ops/demo-map.md). */
export const DEMO_MAP_PATH = path.join(FIXTURES, "okartan-demo.ocd");
/** The demo map's name in `map_sources.file_name` and `map_files.file_name`. */
export const DEMO_MAP_FILE_NAME = "okartan-demo.ocd";
/** Its `map_sources.kind`. */
export const DEMO_MAP_KIND = "ocad";

/**
 * Where the original comes from. A different file under this name fails
 * the guard test. The demo map's own hash is pinned by the fixture and by
 * the public-map list (scripts/lib/map-files.mjs).
 */
export const ORIGINAL_MAP = {
  source: "https://o-kartan.se",
  order: "1056 (2026-11-21)",
  license: "bought by the project maintainer, licensed for any use including publishing",
  sha256: "1db7dde39fb8d32dee5fb1633ce2ecc99c91213113f9cc84c519ec6ea7896672",
};

export const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");

/** The `map_sources` row of the committed demo map. */
export function showcaseSource() {
  const bytes = readFileSync(DEMO_MAP_PATH);
  return { fileHash: sha256Hex(bytes), kind: DEMO_MAP_KIND, bytes, sizeBytes: bytes.byteLength, fileName: DEMO_MAP_FILE_NAME };
}

async function importApi() {
  return Promise.all([
    import(path.join(API_SRC, "import", "ocad.ts")),
    import(path.join(API_SRC, "map-store", "documents.ts")),
    import(path.join(API_SRC, "map-store", "map-file-metadata.ts")),
    import(path.join(ROOT, "packages", "shared", "src", "index.ts")),
  ]).then(([ocad, documents, metadata, shared]) => ({ ocad, documents, metadata, shared }));
}

let loaded;
/** Under `tsx` the TypeScript sources import as they are; under plain `node` register tsx's loader first. */
export async function loadApiModules() {
  if (!loaded) {
    if (!process.execArgv.some((a) => a.includes("tsx"))) (await import("tsx/esm/api")).register();
    loaded = importApi();
  }
  return loaded;
}

/**
 * Import the committed demo map the way the API's worker does, for the
 * tests: the document's header summary, its frame and the pin's
 * quick-access columns at rotation correction 0.
 */
export async function importShowcaseMap() {
  const { ocad, documents, metadata, shared } = await loadApiModules();
  const source = showcaseSource();
  const result = await ocad.importMapToDocument(source.bytes, source.fileName, source.kind);
  const { header } = shared.mapDocument.readMapDocumentHeader(result.bytes);
  const summary = documents.documentHeaderSummary(header);
  const frame = metadata.documentFrameSchema.parse(summary);
  return { source, result, header: summary, frame, columns: metadata.mapFileMetadataFor(frame, null, 0) };
}
