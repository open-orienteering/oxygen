import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type TrueTypeFont, parseTrueType } from "../truetype.js";

const fontsDir = fileURLToPath(new URL("../../../fonts/", import.meta.url));

function load(file: string, family: "liberation-sans" | "liberation-sans-narrow"): TrueTypeFont {
  const buf = readFileSync(fontsDir + file);
  const copy = new ArrayBuffer(buf.byteLength);
  new Uint8Array(copy).set(buf);
  return parseTrueType(copy, family);
}

let cache: { sans: TrueTypeFont; narrow: TrueTypeFont } | undefined;

/** The bundled Liberation faces, parsed once per test run. */
export function liberation(): { sans: TrueTypeFont; narrow: TrueTypeFont } {
  if (!cache) {
    cache = {
      sans: load("LiberationSans-Regular.ttf", "liberation-sans"),
      narrow: load("LiberationSansNarrow-Regular.ttf", "liberation-sans-narrow"),
    };
  }
  return cache;
}
