/**
 * The PDF writer stays in the print worker's chunk (docs/course-print.md
 * §8.6, G16; 05 §5.11 phase 2 "lazy-loaded"): `print/worker.ts` is the only
 * web module that imports `@oxygen/shared/print` at runtime; elsewhere
 * only `import type`. And the exports' `maps.pdf` URLs are recognised for
 * the device path, any other file is not.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mapsPdfTarget } from "../../lib/download-api";
import { exportEntries } from "../../lib/editor/export-menu";

const srcDir = resolve(import.meta.dirname, "../..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "__tests__" ? [] : sources(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe("the print module's imports", () => {
  it("only print/worker.ts imports @oxygen/shared/print at runtime", () => {
    const runtime = sources(srcDir).filter((file) => {
      const text = readFileSync(file, "utf8");
      return [...text.matchAll(/import\s+(type\s+)?[^;]*?from\s+["']@oxygen\/shared\/print["']/g)].some((m) => !m[1])
        || /import\(\s*["']@oxygen\/shared\/print["']\s*\)/.test(text);
    });
    expect(runtime.map((f) => relative(srcDir, f))).toEqual(["print/worker.ts"]);
  });
});

describe("mapsPdfTarget", () => {
  it("is [nameId, query] for every map entry of Export ▾ and null for descriptions, IOF XML and Purple Pen", () => {
    const entries = exportEntries({ nameId: "ev 1", courseSeq: 3, classSeq: 4, sheetSeq: 5, canEdit: true, variants: [{ key: "AB", runnerCount: 2 }], variantKey: "AB" });
    const targets = Object.fromEntries(entries.map((e) => [e.id, mapsPdfTarget(e.url)]));
    expect(targets).toEqual({
      sheet: ["ev 1", "?maps=5"],
      course: ["ev 1", "?courses=3"],
      variant: ["ev 1", "?variants=3%3AAB"],
      allVariations: ["ev 1", "?allVariations=3"],
      courseRunners: ["ev 1", "?courses=3&copies=runners"],
      class: ["ev 1", "?classes=4"],
      all: ["ev 1", ""],
      allControls: ["ev 1", "?allControls=1"],
      setter: ["ev 1", "?setter=1"],
      descriptions: null,
      iofxml: null,
      ppen: null,
    });
  });
});
