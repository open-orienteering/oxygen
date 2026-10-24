/** A small aligned ISOM document and a course request, for the dynamic-bucket tests (§5.2 "Dynamic bucket"). */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { course, mapDocument, symbolLibrary } from "@oxygen/shared";
import type { CourseLayerRequest } from "../worker";
import { parseTextAtlasPage } from "../text-atlas";

const fontsDir = resolve(import.meta.dirname, "../../../../shared/fonts");
export const fontBytes = (file: string) => {
  const b = readFileSync(resolve(fontsDir, file));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
export const latin = () => parseTextAtlasPage(JSON.parse(readFileSync(resolve(fontsDir, "msdf/text-atlas.latin.json"), "utf8")));

/** The ISOM palette as an aligned stack: no upper white (ISOM has none), lower and upper purple. */
export function isomStack(): mapDocument.DocumentColour[] {
  return symbolLibrary.paletteStack("iof2024", "ISOM2017-2").map((c) => ({ ...c, paletteIds: [c.id.slice(c.id.indexOf(":") + 1)] }));
}

export const indexOf = (stack: readonly { id: string }[], id: string) => stack.findIndex((c) => c.id === `iof2024:${id}`);

/**
 * A document: one black line (below upper purple: keeps its index) and one line in the stack's top
 * row (above it: moves up one when upper white is inserted). 100 units per mm.
 */
export function documentBytes(colours = isomStack()): ArrayBuffer {
  const black = indexOf(colours, "black100");
  const top = colours.length - 1;
  const line = (code: string, colour: number) => ({ code, name: code, kind: "line" as const, render: { type: "line" as const, id: code, code, name: code, main: { colour, widthUm: 300 } } });
  const u8 = mapDocument.encodeMapDocument({
    header: {
      format: { version: 1, importer: "test-1" },
      source: { kind: "ocad", version: "2018.8.3", hash: "00".repeat(32), bytes: 1 },
      unitsPerMm: 100,
      mapScale: 15000,
      library: { id: "ISOM2017-2", version: "1" },
      georeferencing: { crs: null, paperOrigin: null },
      colours,
      symbols: [line("516.0", black), line("999.0", top)],
    },
    objects: [
      // A black line across the first leg (x = 25 mm), and a top-row line elsewhere.
      { symbolIdx: 0, type: mapDocument.OBJECT_TYPE.line, sourceIndex: 0, coords: [2500, 0, 2500, 2000], flags: [0, 0] },
      { symbolIdx: 1, type: mapDocument.OBJECT_TYPE.line, sourceIndex: 1, coords: [0, 6000, 8000, 6000], flags: [0, 0] },
    ],
  });
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

const site = (id: string, kind: course.CourseSite["kind"], x: number, y: number): course.CourseSite => ({ id, code: id, kind, x, y });
export const request = (over: Partial<CourseLayerRequest> = {}): CourseLayerRequest => ({
  structure: { version: 1, id: "c1", orderMode: "ordered", items: ["S", "31", "32", "F"].map((siteId) => ({ siteId })) },
  sites: [site("S", "start", 10, 10), site("31", "control", 40, 10), site("32", "control", 60, 40), site("F", "finish", 10, 40)],
  objects: [],
  appearance: {},
  viewOptions: { labelMode: "sequence" },
  ...over,
});

