/**
 * `@oxygen/shared/print` runs in the API and, later, in a Web Worker
 * (research 05 §5.11; docs/course-print.md §1): no Node API, no native
 * rasteriser in the module itself — SVG logos arrive as PNG bytes.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("../", import.meta.url));
const sources = readdirSync(dir).filter((f) => f.endsWith(".ts"));

describe("print module is isomorphic", () => {
  it.each(sources)("%s imports no Node API, Buffer, sharp or resvg", (file) => {
    const src = readFileSync(dir + file, "utf8");
    expect(src).not.toMatch(/from\s+["'](node:|fs|path|url|crypto|sharp|@resvg)/);
    expect(src).not.toMatch(/\bBuffer\b|\bprocess\./);
  });
});
