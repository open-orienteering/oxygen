/**
 * Test fixture of the print pipeline's shared tests (G13): a small map
 * document on an aligned ISOM colour stack — a path through the centre, a
 * boulder, a path far off, and a 1:10 000 header — as the encoded bytes
 * `prepareDocument` decodes; and the bundled fonts as `PrintFonts`. Node
 * reads the font files here, in the test only: the module under test
 * takes bytes.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { alignedStack } from "../../course/__tests__/helpers.js";
import { OBJECT_TYPE, encodeMapDocument, type MapDocumentInput } from "../../map-document/index.js";
import type { FontFamily } from "../../render/pass-stream.js";
import { SYMBOL_LIBRARY_VERSION } from "../../symbol-library/index.js";
import { type PrintFonts, printFontsFromFaces } from "../course-pages.js";

const colours = alignedStack("ISOM2017-2");
const black = colours.findIndex((c) => c.paletteIds?.includes("black100"));

/** Native units: 100 per mm. */
export const printDocumentInput: MapDocumentInput = {
  header: {
    format: { version: 1, importer: "test-1" },
    source: { kind: "ocad", version: "2018", hash: "00".repeat(32), bytes: 1 },
    unitsPerMm: 100,
    mapScale: 10000,
    documentFactor: 1.5,
    library: { id: "ISOM2017-2", version: SYMBOL_LIBRARY_VERSION },
    georeferencing: { crs: null, paperOrigin: null },
    colours,
    symbols: [
      { code: "505.0", name: "Path", kind: "line", render: { type: "line", id: "s:505", code: "505", name: "Path", main: { colour: black, widthUm: 250 } } },
      { code: "204.0", name: "Boulder", kind: "point", render: null, match: { canonicalId: "ISOM2017-2:204", method: "explicit", state: "auto", confidence: 1, libraryVersion: SYMBOL_LIBRARY_VERSION } },
    ],
  },
  objects: [
    { symbolIdx: 0, type: OBJECT_TYPE.line, sourceIndex: 0, coords: [-5000, -4000, 5000, 4000], flags: [0, 0] },
    { symbolIdx: 1, type: OBJECT_TYPE.point, sourceIndex: 1, coords: [1500, -1000], flags: [0] },
    { symbolIdx: 0, type: OBJECT_TYPE.line, sourceIndex: 2, coords: [60000, 60000, 61000, 60000], flags: [0, 0] },
  ],
};

export const printDocumentBytes = (): Uint8Array => encodeMapDocument(printDocumentInput);

const fontsDir = fileURLToPath(new URL("../../../fonts/", import.meta.url));
/** The bundled faces in the API's order (`render/fonts.ts`): regular, narrow, bold. */
const FACE_FILES: [FontFamily, string][] = [
  ["liberation-sans", "LiberationSans-Regular.ttf"],
  ["liberation-sans-narrow", "LiberationSansNarrow-Regular.ttf"],
  ["liberation-sans", "LiberationSans-Bold.ttf"],
];

export const bundledFontsForTest = (): PrintFonts => printFontsFromFaces(FACE_FILES.map(([family, file]) => ({ family, data: new Uint8Array(readFileSync(fontsDir + file)) })));
