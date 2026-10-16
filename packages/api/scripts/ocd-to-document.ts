/**
 * Converts an OCAD file to a map document (docs/map-document-format.md):
 *
 *   pnpm --filter @oxygen/api document:from-ocd <in.ocd> [out.oxvm] [--json]
 *
 * Writes `out.oxvm` (default: the input name with `.oxvm`) and, with
 * `--json`, the debug projection next to it as `.vmap.json`. Prints the
 * document hash, counts, section sizes and warnings — the same numbers
 * the import report will carry.
 */

import { readFile, writeFile } from "node:fs/promises";
import { mapDocument } from "@oxygen/shared";
import { importOcadToDocument } from "../src/import/ocad.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const [input, output] = args.filter((a) => !a.startsWith("--"));
if (!input) {
  console.error("usage: ocd-to-document <in.ocd> [out.oxvm] [--json]");
  process.exit(2);
}
const out = output ?? input.replace(/\.ocd$/i, "") + ".oxvm";
const file = await readFile(input);
const result = await importOcadToDocument(file, input.split("/").pop() ?? input);
await writeFile(out, result.bytes);
if (json) {
  const projection = mapDocument.toJsonProjection(mapDocument.decodeMapDocument(result.bytes));
  await writeFile(out.replace(/\.oxvm$/, "") + ".vmap.json", JSON.stringify(projection, null, 1));
}
const { header, bodyOffset } = mapDocument.readMapDocumentHeader(result.bytes);
const s = header.objects.sections;
console.log(`${out}: ${result.bytes.byteLength} bytes, sha256 ${result.documentHash}`);
console.log(`  source ${header.source.kind} ${header.source.version}, 1:${header.mapScale}, ${header.unitsPerMm} units/mm, crs ${header.georeferencing.crs?.name ?? "none"}`);
console.log(`  objects ${header.objects.count}, coords ${result.counts.coordinates}, symbols ${header.symbols.length}, colours ${header.colours.length}, strings ${header.strings.length}`);
console.log(`  sections: header ${bodyOffset} B, attrs ${s.attrs.length} B, bboxes ${s.bboxes.length} B, geometry ${s.geometry.length} B`);
console.log(`  timings: read ${result.timings.read.toFixed(0)} ms, normalise ${result.timings.normalise.toFixed(0)} ms, encode ${result.timings.encode.toFixed(0)} ms`);
for (const w of result.warnings) console.log(`  warning ${w.code} ×${w.count}${w.message ? ` — ${w.message}` : ""}`);
