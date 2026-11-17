/**
 * `@oxygen/shared/print` and the print pipeline's layout half run in the
 * API and in a Web Worker (research 05 §5.11, §9 item 8; docs/course-print.md
 * §1): no Node API, no native rasteriser — fonts and SVG logos arrive as
 * bytes. The module and everything it imports, transitively, is checked;
 * so is the package root, which must not reach the PDF library.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const printDir = fileURLToPath(new URL("../", import.meta.url));
const srcDir = resolve(printDir, "..");

/** Every source file reached from `entry` through relative imports (type-only imports included: they are checked, not executed). */
function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = resolve(dirname(file), m[1].replace(/\.js$/, ".ts"));
      const file2 = existsSync(target) ? target : existsSync(`${target}.ts`) ? `${target}.ts` : resolve(target, "index.ts");
      if (existsSync(file2)) visit(file2);
    }
  };
  visit(entry);
  return [...seen].map((f) => f.slice(srcDir.length + 1)).sort();
}

/** The module's own files: `index.ts` and everything it re-exports. */
const printFiles: string[] = ["index.ts", ...Array.from(readFileSync(printDir + "index.ts", "utf8").matchAll(/from "\.\/([\w-]+)\.js"/g), (m) => `${m[1]}.ts`)];

/** The isomorphic print pipeline (G13): the subpath and the layout half in the root export. */
const ENTRIES = ["print/index.ts", "course-maps/resolve-layout.ts", "course-maps/resolve-sheet.ts", "course-maps/sheet-rows.ts"].filter((f) => existsSync(resolve(srcDir, f)));
const pipelineFiles = [...new Set(ENTRIES.flatMap((e) => reachable(resolve(srcDir, e))))].sort();

describe("print module is isomorphic", () => {
  it("re-exports every file of the module", () => {
    expect(printFiles).toEqual(
      expect.arrayContaining(["writer.ts", "operators.ts", "compose.ts", "page.ts", "description.ts", "description-sheet.ts", "geo.ts", "prepared-document.ts", "course-pages.ts"]),
    );
  });

  it("walks the moved pipeline modules", () => {
    expect(pipelineFiles).toEqual(
      expect.arrayContaining([
        "print/course-pages.ts",
        "print/prepared-document.ts",
        "course-maps/resolve-layout.ts",
        "course-maps/resolve-sheet.ts",
        "course-maps/sheet-rows.ts",
        "course/sequence.ts",
      ]),
    );
  });

  it.each(pipelineFiles)("%s imports no Node API, Buffer, sharp or resvg", (file: string) => {
    const src = readFileSync(resolve(srcDir, file), "utf8");
    // Static, side-effect and dynamic imports, and require.
    expect(src).not.toMatch(/(?:from|import|require)\s*\(?\s*["'](node:|fs|path|url|crypto|sharp|@resvg|worker_threads)/);
    expect(src).not.toMatch(/\bBuffer\b|\bprocess\.|\bsetImmediate\b/);
  });
});

describe("the package root stays free of the PDF library", () => {
  const rootFiles = reachable(resolve(srcDir, "index.ts"));

  it("reaches the moved layout modules", () => {
    expect(rootFiles).toEqual(expect.arrayContaining(["course-maps/resolve-layout.ts", "course-maps/resolve-sheet.ts", "course-maps/sheet-rows.ts"]));
  });

  it("never reaches the writer or @cantoo/pdf-lib", () => {
    expect(rootFiles).not.toContain("print/writer.ts");
    for (const file of rootFiles) expect(readFileSync(resolve(srcDir, file), "utf8"), file).not.toMatch(/["']@cantoo\/pdf-lib["']/);
  });
});
