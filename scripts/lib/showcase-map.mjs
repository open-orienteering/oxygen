/**
 * The Demo Competition's map (docs/demo.md, "The map"): the CC0 Puit de
 * Laven map from github.com/dmkaplan2000/orienteering-maps, committed
 * as it was published (`puit-de-laven.omap`), and the demo map made of it
 * by `scripts/inject-demo-points.mjs` (`puit-de-laven-demo.omap`, the
 * invented point features added).
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
import { DEMO_SEED, injectDemoPoints } from "./inject-demo-points.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const API_SRC = path.join(ROOT, "packages", "api", "src");
const FIXTURES = path.join(ROOT, "docs", "screenshots", "fixtures");

/** The CC0 map as published upstream. */
export const ORIGINAL_MAP_PATH = path.join(FIXTURES, "puit-de-laven.omap");
/** The demo map: the original plus the injected point features. */
export const DEMO_MAP_PATH = path.join(FIXTURES, "puit-de-laven-demo.omap");
/** The demo map's name in `map_sources.file_name` and `map_files.file_name`. */
export const DEMO_MAP_FILE_NAME = "puit-de-laven-demo.omap";

/**
 * Where the original comes from. The SHA-256 is of
 * `puit-de-laven/puit-de-laven.omap` at the upstream commit (its git blob
 * is 9d0a02b7…); a different file under this name fails the guard test.
 */
export const ORIGINAL_MAP = {
  repository: "https://github.com/dmkaplan2000/orienteering-maps",
  path: "puit-de-laven/puit-de-laven.omap",
  commit: "38f674c68e34db8687a9bd3da069d4470a98ca71",
  author: "David Kaplan",
  license: "CC0-1.0",
  sha256: "57ae1a9db2457db9fcdb2a9f0c2999ac694231585c52ee97693a505a8db69daf",
};

export const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");

/** The demo map as the injection makes it from the committed original. */
export function buildDemoMap(seed = DEMO_SEED) {
  return Buffer.from(injectDemoPoints(readFileSync(ORIGINAL_MAP_PATH, "utf8"), seed).text, "utf8");
}

/** The `map_sources` row of the committed demo map. */
export function showcaseSource() {
  const bytes = readFileSync(DEMO_MAP_PATH);
  return { fileHash: sha256Hex(bytes), kind: "omap", bytes, sizeBytes: bytes.byteLength, fileName: DEMO_MAP_FILE_NAME };
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
  const result = await ocad.importMapToDocument(source.bytes, source.fileName, "omap");
  const { header } = shared.mapDocument.readMapDocumentHeader(result.bytes);
  const summary = documents.documentHeaderSummary(header);
  const frame = metadata.documentFrameSchema.parse(summary);
  return { source, result, header: summary, frame, columns: metadata.mapFileMetadataFor(frame, null, 0) };
}
