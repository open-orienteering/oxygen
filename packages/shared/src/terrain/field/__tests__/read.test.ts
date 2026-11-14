import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as read from "../read.js";

const FIELD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every module reached from `entry` through relative imports and re-exports (type-only ones too). */
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:import|export)\s[^;]*?from\s+"(\.[^"]+)"/g)) walk(resolve(dirname(file), m[1].replace(/\.js$/, ".ts")));
  };
  walk(entry);
  return seen;
}

describe("terrain/field/read.js, the client entry (map-terrain.md §5)", () => {
  it("reaches no derivation module", () => {
    const graph = [...importGraph(resolve(FIELD_DIR, "read.ts"))].map((f) => f.slice(resolve(FIELD_DIR, "..").length + 1));
    expect(graph.sort()).toEqual(["field/codec.ts", "field/normals.ts", "field/read.ts", "field/sample.ts", "field/types.ts"]);
  });

  it("exports the decode, sample and normals side", () => {
    for (const name of ["decodeHeightField", "encodeHeightField", "sampleHeight", "sampleConfident", "fieldCell", "heightNormals", "HEIGHT_NO_DATA", "heightFieldHeaderSchema"]) expect(read).toHaveProperty(name);
    expect(read).not.toHaveProperty("buildHeightField");
  });
});
