/**
 * `@oxygen/shared/print` runs in the API and, later, in a Web Worker
 * (research 05 §5.11; docs/course-print.md §1): no Node API, no native
 * rasteriser in the module itself — SVG logos arrive as PNG bytes.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("../", import.meta.url));
/** The module's files: `index.ts` and everything it re-exports. */
const sources: string[] = ["index.ts", ...Array.from(readFileSync(dir + "index.ts", "utf8").matchAll(/from "\.\/([\w-]+)\.js"/g), (m) => `${m[1]}.ts`)];

describe("print module is isomorphic", () => {
  it("re-exports every file of the module", () => {
    expect(sources).toEqual(expect.arrayContaining(["writer.ts", "operators.ts", "compose.ts", "page.ts", "description.ts", "geo.ts"]));
  });

  it.each(sources)("%s imports no Node API, Buffer, sharp or resvg", (file: string) => {
    const src = readFileSync(dir + file, "utf8");
    expect(src).not.toMatch(/from\s+["'](node:|fs|path|url|crypto|sharp|@resvg)/);
    expect(src).not.toMatch(/\bBuffer\b|\bprocess\./);
  });
});
