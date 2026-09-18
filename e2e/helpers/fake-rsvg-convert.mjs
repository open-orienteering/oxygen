#!/usr/bin/env node
// Test-only replacement for rsvg-convert. Browser tests exercise Oxygen's
// selection/download/merge path without requiring librsvg on the host; the
// production Docker verification uses the real binary.
import { createRequire } from "node:module";
import { resolve } from "node:path";

const requireFromApi = createRequire(
  resolve(process.cwd(), "packages/api/package.json"),
);
const { PDFDocument } = requireFromApi("pdf-lib");

for await (const _chunk of process.stdin) {
  // Drain the composed SVG. Its content is covered by API unit tests.
}

const pdf = await PDFDocument.create();
pdf.addPage([595.276, 841.89]);
process.stdout.write(Buffer.from(await pdf.save()));
