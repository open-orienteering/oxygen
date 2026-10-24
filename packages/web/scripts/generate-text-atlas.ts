/**
 * Writes the WebGL2 backend's text atlas pages from the bundled fonts
 * (docs/map-rendering.md §4.10): `packages/shared/fonts/msdf/
 * text-atlas.<page>.{png,json}`, MTSDF at 32 px per em, all three faces
 * (Regular, Narrow, Bold) on every page. Run after changing a font file or a page's ranges:
 *
 *   pnpm text-atlas:generate
 *
 * `msdf-atlas-gen` runs in a throwaway Docker image built from a pinned
 * tag (`scripts/text-atlas/Dockerfile`), so two machines produce the
 * same pages without a native toolchain. `map-gl/__tests__/
 * text-atlas.test.ts` fails when the committed pages no longer match the
 * fonts or the ranges.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@oxygen/shared";
import { glyphsetFile, pageFromAtlasJson, pageGlyphIds, TEXT_ATLAS_EM_PX, TEXT_ATLAS_RANGE_PX, type RawAtlasJson } from "../src/map-gl/text-atlas-build.js";
import { TEXT_ATLAS_PAGE_NAMES } from "../src/map-gl/text-atlas.js";

const IMAGE = "oxygen-msdf-atlas-gen";
const fontsDir = fileURLToPath(new URL("../../shared/fonts/", import.meta.url));
const outDir = join(fontsDir, "msdf");
const dockerDir = fileURLToPath(new URL("./text-atlas/", import.meta.url));

const FACES: { family: render.FontFamily; file: string }[] = [
  { family: "liberation-sans", file: "LiberationSans-Regular.ttf" },
  { family: "liberation-sans-narrow", file: "LiberationSansNarrow-Regular.ttf" },
  { family: "liberation-sans", file: "LiberationSans-Bold.ttf" },
];

execFileSync("docker", ["build", "--network", "host", "-q", "-t", IMAGE, dockerDir], { stdio: ["ignore", "ignore", "inherit"] });

const faces = FACES.map(({ family, file }) => {
  const bytes = readFileSync(join(fontsDir, file));
  const font = render.parseTrueType(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), family);
  return { family, bold: font.bold, file, font, sha256: createHash("sha256").update(bytes).digest("hex"), unitsPerEm: font.unitsPerEm };
});

const work = mkdtempSync(join(tmpdir(), "text-atlas-"));
mkdirSync(outDir, { recursive: true });
try {
  const onEarlierPage = faces.map(() => new Set<number>());
  for (const page of TEXT_ATLAS_PAGE_NAMES) {
    const args: string[] = [];
    faces.forEach((f, i) => {
      const ids = pageGlyphIds(f.font, page).filter((g) => !onEarlierPage[i].has(g));
      for (const g of ids) onEarlierPage[i].add(g);
      writeFileSync(join(work, `${f.file}.${page}.txt`), glyphsetFile(ids));
      if (i) args.push("-and");
      args.push("-font", `/fonts/${f.file}`, "-glyphset", `/work/${f.file}.${page}.txt`, "-fontname", `${f.family}${f.bold ? "-bold" : ""}`);
    });
    const uid = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
    execFileSync("docker", [
      "run", "--rm", "--network", "none", "--user", uid, "-v", `${fontsDir}:/fonts:ro`, "-v", `${work}:/work`, IMAGE,
      ...args,
      "-type", "mtsdf", "-format", "png", "-size", String(TEXT_ATLAS_EM_PX), "-pxrange", String(TEXT_ATLAS_RANGE_PX),
      "-yorigin", "top", "-seed", "0", "-threads", "1",
      "-json", `/work/${page}.json`, "-imageout", `/work/${page}.png`,
    ], { stdio: ["ignore", "inherit", "inherit"] });
    const raw = JSON.parse(readFileSync(join(work, `${page}.json`), "utf8")) as RawAtlasJson;
    const out = pageFromAtlasJson(raw, page, faces.map(({ family, bold, sha256, unitsPerEm }) => ({ family, ...(bold ? { bold } : {}), sha256, unitsPerEm })));
    writeFileSync(join(outDir, `text-atlas.${page}.json`), JSON.stringify(out) + "\n");
    copyFileSync(join(work, `${page}.png`), join(outDir, `text-atlas.${page}.png`));
    const n = out.faces.reduce((s, f) => s + f.glyphs.length / 9, 0);
    console.log(`wrote text-atlas.${page} (${out.width}×${out.height}, ${n} glyphs)`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
