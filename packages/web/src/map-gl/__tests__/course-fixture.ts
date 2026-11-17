/** The course fixture for the dynamic-bucket tests (§5.2 "Dynamic bucket"): the document and request from `fixtures/course-document.ts`, the fonts and atlas page from disk. */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseTextAtlasPage } from "../text-atlas";

const fontsDir = resolve(import.meta.dirname, "../../../../shared/fonts");
export const fontBytes = (file: string) => {
  const b = readFileSync(resolve(fontsDir, file));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
export const latin = () => parseTextAtlasPage(JSON.parse(readFileSync(resolve(fontsDir, "msdf/text-atlas.latin.json"), "utf8")));

export { documentBytes, indexOf, isomStack, request } from "../fixtures/course-document";
