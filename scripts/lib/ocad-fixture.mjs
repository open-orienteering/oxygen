/**
 * Deterministic OCAD 2018 fixture builders.
 *
 * Shared by `scripts/generate-test-ocd.mjs` (E2E/course-setting fixture) and
 * the showcase demo map. Output is seeded so a regeneration with no script
 * changes is byte-identical.
 */

// ─── Deterministic PRNG (LCG) ────────────────────────────────────────────────

export function makeRand(seedInit = 0x5eed) {
  let seed = seedInit;
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

// ─── Binary helpers ──────────────────────────────────────────────────────────

class Writer {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  push(buf) {
    this.chunks.push(buf);
    const at = this.length;
    this.length += buf.length;
    return at;
  }
  alloc(size) {
    const buf = Buffer.alloc(size);
    const at = this.push(buf);
    return { buf, at };
  }
  toBuffer() {
    return Buffer.concat(this.chunks, this.length);
  }
}

/** OCAD TdPoly raw coordinate: value in 1/100 mm shifted left 8 bits (flags 0). */
const td = (v) => (v << 8) | 0;

function utf16le(str, byteLength) {
  const buf = Buffer.alloc(byteLength);
  buf.write(str, 0, "utf16le");
  return buf;
}

// ─── Symbol records (OCAD 2018 layout, per ocad2geojson's reader) ────────────

const BASE_SYMBOL_SIZE = 24 + 2 + 2 + 28 + 64 + 484 + 128 + 64; // incl. the 64-byte gap

function symbolHeader(buf, { size, symNum, otp, extent, colorIdx, description }) {
  let o = 0;
  o = buf.writeInt32LE(size, o);
  o = buf.writeInt32LE(symNum, o);
  o = buf.writeInt8(otp, o); // symbol type: 1 point, 2 line, 3 area
  o = buf.writeUInt8(0, o); // flags
  o = buf.writeUInt8(0, o); // selected
  o = buf.writeUInt8(0, o); // status (0 = visible)
  o = buf.writeUInt8(0, o); // preferredDrawingTool
  o = buf.writeUInt8(0, o); // csMode
  o = buf.writeUInt8(0, o); // csObjType
  o = buf.writeUInt8(0, o); // csCdFlags
  o = buf.writeInt32LE(extent, o);
  o = buf.writeUInt32LE(0, o); // filePos
  o = buf.writeUInt8(0, o); // notUsed1
  o = buf.writeUInt8(0, o); // notUsed2
  o = buf.writeInt16LE(1, o); // nColors
  o = buf.writeInt16LE(colorIdx, o); // colors[0]
  o += 26; // colors[1..13]
  utf16le(description, 64).copy(buf, o);
  o += 64;
  o += 484; // iconBits
  o += 128; // symbolTreeGroup
  o += 64; // undocumented gap skipped by the reader
  return o;
}

function elementBytes(elements) {
  return elements.reduce((sum, e) => sum + 16 + e.coords.length * 8, 0);
}

function elementDataSize(elements) {
  return elements.reduce((sum, e) => sum + 2 + e.coords.length, 0);
}

function writeElements(buf, o, elements) {
  for (const e of elements) {
    o = buf.writeInt16LE(e.type, o);
    o = buf.writeUInt16LE(0, o); // flags
    o = buf.writeInt16LE(e.color, o);
    o = buf.writeInt16LE(e.lineWidth ?? 0, o);
    o = buf.writeInt16LE(e.diameter ?? 0, o);
    o = buf.writeInt16LE(e.coords.length, o);
    o = buf.writeUInt32LE(0, o); // reserved
    for (const [x, y] of e.coords) {
      o = buf.writeInt32LE(td(x), o);
      o = buf.writeInt32LE(td(y), o);
    }
  }
  return o;
}

export function pointSymbol({ symNum, extent, colorIdx, description, elements }) {
  const size = BASE_SYMBOL_SIZE + 4 + elementBytes(elements);
  const buf = Buffer.alloc(size);
  let o = symbolHeader(buf, { size, symNum, otp: 1, extent, colorIdx, description });
  o = buf.writeUInt16LE(elementDataSize(elements), o);
  o = buf.writeInt16LE(0, o); // reserved
  writeElements(buf, o, elements);
  return buf;
}

export function lineSymbol({ symNum, extent, colorIdx, description, lineWidth }) {
  const size = BASE_SYMBOL_SIZE + 76;
  const buf = Buffer.alloc(size);
  let o = symbolHeader(buf, { size, symNum, otp: 2, extent, colorIdx, description });
  o = buf.writeInt16LE(colorIdx, o); // lineColor
  o = buf.writeInt16LE(lineWidth, o);
  o += 22;
  o += 26; // DoubleLine11
  o += 6; // Decrease11
  o += 6; // frColor, frWidth, frStyle
  o += 10; // prim/sec/corner/start/end DSize = 0
  o += 2; // useSymbolFlags, reserved
  return buf;
}

export function areaSymbol({ symNum, extent, colorIdx, description }) {
  const size = BASE_SYMBOL_SIZE + 36;
  const buf = Buffer.alloc(size);
  let o = symbolHeader(buf, { size, symNum, otp: 3, extent, colorIdx, description });
  o = buf.writeInt32LE(0, o); // borderSym
  o = buf.writeInt16LE(colorIdx, o); // fillColor
  o += 12; // hatchMode/Color/LineWidth/Dist/Angle1/Angle2
  o = buf.writeUInt8(1, o); // fillOn
  o = buf.writeUInt8(0, o); // borderOn
  return buf;
}

function objectRecord({ sym, otp, coords, text = "" }) {
  const textSlots = text ? Math.ceil((text.length + 1) / 4) : 0;
  const size = 56 + coords.length * 8 + textSlots * 8;
  const buf = Buffer.alloc(size);
  let o = 0;
  o = buf.writeInt32LE(sym, o);
  o = buf.writeUInt8(otp, o);
  o = buf.writeUInt8(1, o); // unicode
  o = buf.writeInt16LE(0, o); // ang
  o = buf.writeInt32LE(0, o); // col
  o = buf.writeInt16LE(0, o); // lineWidth
  o = buf.writeInt16LE(0, o); // diamFlags
  o = buf.writeInt32LE(0, o); // serverObjectId
  o = buf.writeInt32LE(0, o); // height
  o = buf.writeDoubleLE(0, o); // creationDate
  o = buf.writeUInt32LE(0, o); // multirepresentationId
  o = buf.writeDoubleLE(0, o); // modificationDate
  o = buf.writeUInt32LE(coords.length, o); // nItem
  o = buf.writeUInt16LE(textSlots, o); // nText
  o = buf.writeUInt16LE(0, o); // nObjectString
  o = buf.writeUInt16LE(0, o); // nDatabaseString
  o = buf.writeUInt8(0, o); // objectStringType
  o = buf.writeUInt8(0, o); // res1
  for (const [x, y] of coords) {
    o = buf.writeInt32LE(td(x), o);
    o = buf.writeInt32LE(td(y), o);
  }
  if (textSlots > 0) utf16le(text, textSlots * 8).copy(buf, o);
  return buf;
}

function objectBounds(coords, margin) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of coords) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX: minX - margin, minY: minY - margin, maxX: maxX + margin, maxY: maxY + margin };
}

const DEFAULT_COLORS = [
  { recType: 9, text: "Purple\tn0\tc35.0\tm85.0\ty0.0\tk0.0" },
  { recType: 9, text: "Black\tn1\tc0.0\tm0.0\ty0.0\tk100.0" },
  { recType: 9, text: "Yellow\tn2\tc0.0\tm27.0\ty79.0\tk0.0" },
  { recType: 9, text: "Blue\tn3\tc100.0\tm0.0\ty0.0\tk0.0" },
];

export function georeferenceString({ scale, easting, northing }) {
  return `\tm${scale}\tg50.000000\tr1\td500\ti1000\tx${easting}\ty${northing}\ta0.00000000`;
}

/**
 * Assemble an OCAD 2018 file. Parameter strings are written first so the
 * map-scale heuristic in ocd-course-parser.ts (first /\bm(\d+)\b/ in the
 * leading 50 kB) hits the georeference string before any binary noise.
 *
 * @param {{ fileType?: number, strings: {recType:number, text:string}[], symbols: Buffer[], objects: object[] }} spec
 */
export function assembleOcad({ fileType = 1, strings, symbols, objects }) {
  if (objects.length > 256) throw new Error("More than one object index block needed");

  const w = new Writer();
  const header = w.alloc(64);

  const stringIndexOffset = w.length;
  const stringIndex = w.alloc(4 + 256 * 16);
  for (let i = 0; i < strings.length; i++) {
    const bytes = Buffer.from(strings[i].text + "\0", "utf8");
    const pos = w.push(bytes);
    const o = 4 + i * 16;
    stringIndex.buf.writeInt32LE(pos, o);
    stringIndex.buf.writeInt32LE(bytes.length, o + 4);
    stringIndex.buf.writeInt32LE(strings[i].recType, o + 8);
    stringIndex.buf.writeInt32LE(0, o + 12);
  }

  const symbolIndexOffset = w.length;
  const symbolIndex = w.alloc(4 + 256 * 4);
  symbols.forEach((buf, i) => {
    const pos = w.push(buf);
    symbolIndex.buf.writeInt32LE(pos, 4 + i * 4);
  });

  const objectIndexOffset = w.length;
  const objectIndex = w.alloc(4 + 256 * 40);
  objects.forEach((def, i) => {
    const record = objectRecord(def);
    const pos = w.push(record);
    const margin = def.otp === 1 ? 400 : 40;
    const b = objectBounds(def.coords, margin);
    const o = 4 + i * 40;
    objectIndex.buf.writeInt32LE(td(b.minX), o);
    objectIndex.buf.writeInt32LE(td(b.minY), o + 4);
    objectIndex.buf.writeInt32LE(td(b.maxX), o + 8);
    objectIndex.buf.writeInt32LE(td(b.maxY), o + 12);
    objectIndex.buf.writeUInt32LE(pos, o + 16);
    objectIndex.buf.writeUInt32LE(record.length, o + 20);
    objectIndex.buf.writeInt32LE(def.sym, o + 24);
    objectIndex.buf.writeUInt8(def.otp, o + 28);
    objectIndex.buf.writeUInt8(0, o + 29);
    objectIndex.buf.writeUInt8(1, o + 30); // status: 1 = normal
    objectIndex.buf.writeUInt8(0, o + 31);
  });

  {
    const h = header.buf;
    h.writeUInt16LE(0x0cad, 0);
    h.writeUInt8(fileType, 2);
    h.writeUInt8(0, 3);
    h.writeUInt16LE(2018, 4);
    h.writeUInt8(0, 6);
    h.writeUInt8(0, 7);
    h.writeUInt32LE(symbolIndexOffset, 8);
    h.writeUInt32LE(objectIndexOffset, 12);
    h.writeUInt32LE(stringIndexOffset, 32);
  }

  return w.toBuffer();
}

export function terrainSymbols() {
  return [
    lineSymbol({
      symNum: 505000,
      extent: 20,
      colorIdx: 1,
      description: "Path",
      lineWidth: 25,
    }),
    areaSymbol({
      symNum: 403000,
      extent: 0,
      colorIdx: 2,
      description: "Rough open land",
    }),
    lineSymbol({
      symNum: 601000,
      extent: 10,
      colorIdx: 3,
      description: "Magnetic north line",
      lineWidth: 10,
    }),
  ];
}

// ─── E2E course-setting fixture ──────────────────────────────────────────────

export const E2E_OCAD = {
  scale: 7500,
  easting: 500000,
  northing: 6500000,
};

/**
 * Synthetic OCAD 2018 course-setting file for `e2e/test.ocd`.
 * Layout, codes, and georeference are load-bearing for E2E and integration
 * tests — see docs/e2e-test-ocd-fixture.md.
 */
export function buildE2eTestOcad() {
  const rand = makeRand(0x5eed);
  const SCALE = E2E_OCAD.scale;
  const EASTING = E2E_OCAD.easting;
  const NORTHING = E2E_OCAD.northing;

  const CODES = [];
  for (let c = 61; c <= 88; c++) CODES.push(String(c));

  const controlPos = new Map();
  {
    const cols = 7;
    let i = 0;
    for (const code of CODES) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = -5400 + col * 1800 + Math.round((rand() - 0.5) * 900);
      const y = -3600 + row * 2400 + Math.round((rand() - 0.5) * 1100);
      controlPos.set(code, { x, y });
      i++;
    }
  }
  controlPos.set("S1", { x: -6800, y: 200 });
  controlPos.set("M1", { x: -6400, y: -900 });

  const COURSES = {
    A: ["61", "64", "67", "70", "72", "76", "79", "82", "85", "88", "62", "65", "68", "71", "74", "77", "80", "83"],
    B: ["63", "66", "69", "72", "75", "78", "81", "84", "87", "61", "65", "70", "74", "79", "88"],
    C: ["62", "67", "73", "77", "82", "86", "63", "69", "76", "84", "88"],
    D: ["64", "68", "74", "80", "85", "61", "66", "72", "78", "83"],
    E: ["65", "71", "79", "86", "62", "70", "81", "87"],
  };

  {
    const used = new Set(Object.values(COURSES).flat());
    for (const code of CODES) {
      if (!used.has(code)) throw new Error(`Control ${code} unused by all courses`);
    }
  }

  const strings = [...DEFAULT_COLORS];
  strings.push({
    recType: 1039,
    text: georeferenceString({ scale: SCALE, easting: EASTING, northing: NORTHING }),
  });
  for (const [name, controls] of Object.entries(COURSES)) {
    strings.push({
      recType: 2,
      text: `${name}\tsS1\t${controls.map((c) => `c${c}`).join("\t")}\tfM1`,
    });
  }

  const symbols = [
    pointSymbol({
      symNum: 701000,
      extent: 400,
      colorIdx: 0,
      description: "Start",
      elements: [
        {
          type: 1,
          color: 0,
          lineWidth: 35,
          coords: [
            [0, 402],
            [348, -201],
            [-348, -201],
            [0, 402],
          ],
        },
      ],
    }),
    pointSymbol({
      symNum: 702000,
      extent: 350,
      colorIdx: 0,
      description: "Control point",
      elements: [{ type: 3, color: 0, lineWidth: 35, diameter: 600, coords: [[0, 0]] }],
    }),
    pointSymbol({
      symNum: 706000,
      extent: 400,
      colorIdx: 0,
      description: "Finish",
      elements: [
        { type: 3, color: 0, lineWidth: 35, diameter: 500, coords: [[0, 0]] },
        { type: 3, color: 0, lineWidth: 35, diameter: 700, coords: [[0, 0]] },
      ],
    }),
    ...terrainSymbols(),
    pointSymbol({
      symNum: 204000,
      extent: 60,
      colorIdx: 1,
      description: "Boulder",
      elements: [{ type: 3, color: 1, lineWidth: 20, diameter: 60, coords: [[0, 0]] }],
    }),
    areaSymbol({
      symNum: 521000,
      extent: 0,
      colorIdx: 1,
      description: "Building",
    }),
  ];

  const BOULDER = [6800, 4200];
  const BUILDING = [
    [4800, 3900],
    [5800, 3900],
    [5800, 4600],
    [4800, 4600],
    [4800, 3900],
  ];

  const objects = [];
  objects.push({
    sym: 403000,
    otp: 3,
    coords: [
      [-7400, -4600],
      [7200, -4800],
      [7600, 800],
      [4200, 4400],
      [-2600, 4600],
      [-7600, 3400],
      [-7400, -4600],
    ],
  });

  for (let x = -6600; x <= 6600; x += 1200) {
    objects.push({
      sym: 601000,
      otp: 2,
      coords: [
        [x, -5000],
        [x, 5000],
      ],
    });
  }

  for (let p = 0; p < 3; p++) {
    const y0 = -3400 + p * 3000;
    const pts = [];
    for (let x = -7200; x <= 7200; x += 1800) {
      pts.push([x, y0 + Math.round((rand() - 0.5) * 1400)]);
    }
    objects.push({ sym: 505000, otp: 2, coords: pts });
  }

  objects.push({ sym: 204000, otp: 1, coords: [BOULDER] });
  objects.push({ sym: 521000, otp: 3, coords: BUILDING });

  {
    const c79 = controlPos.get("79");
    const c80 = controlPos.get("80");
    objects.push({ sym: 204000, otp: 1, coords: [[c79.x, c79.y + 250]] });
    objects.push({
      sym: 204000,
      otp: 1,
      coords: [[Math.round((c79.x + c80.x) / 2), Math.round((c79.y + c80.y) / 2)]],
    });
  }

  objects.push({
    sym: 701000,
    otp: 1,
    coords: [[controlPos.get("S1").x, controlPos.get("S1").y]],
    text: "aS1",
  });
  objects.push({
    sym: 706000,
    otp: 1,
    coords: [[controlPos.get("M1").x, controlPos.get("M1").y]],
    text: "aM1",
  });
  for (const code of CODES) {
    const { x, y } = controlPos.get(code);
    objects.push({ sym: 702000, otp: 1, coords: [[x, y]], text: `a${code}` });
  }

  return assembleOcad({ fileType: 1, strings, symbols, objects });
}

// ─── Showcase demo map ───────────────────────────────────────────────────────

/**
 * CRS / paper extent of the Demo Competition map, chosen so the five
 * cached overview tiles (z10–13) sit on the same slippy-map coordinates.
 * Geometry is synthetic.
 *
 * Bounds are OCAD paper units (1/100 mm), matching ocad2geojson getBounds().
 */
export const SHOWCASE_OCAD = {
  fileName: "demo-map.ocd",
  scale: 15000,
  easting: 679000,
  northing: 6572000,
  /** [minX, minY, maxX, maxY] in 1/100 mm */
  bounds: [-5402, -9, 8374, 9978],
};

const MAX_SHOWCASE_BYTES = 80_000;

/**
 * Synthetic backing map for the Demo Competition fixture. Same SWEREF99 TM
 * georeference and paper extent as the cached overview tiles, but only
 * generated symbols and geometry.
 */
export function buildShowcaseOcad() {
  const rand = makeRand(0xc0de);
  const [minX, minY, maxX, maxY] = SHOWCASE_OCAD.bounds;
  const strings = [
    ...DEFAULT_COLORS,
    {
      recType: 1039,
      text: georeferenceString({
        scale: SHOWCASE_OCAD.scale,
        easting: SHOWCASE_OCAD.easting,
        northing: SHOWCASE_OCAD.northing,
      }),
    },
  ];

  const symbols = terrainSymbols();
  const objects = [];

  // Area covering the historic paper extent so getBounds() stays close.
  objects.push({
    sym: 403000,
    otp: 3,
    coords: [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
      [minX, minY],
    ],
  });

  const step = 1200;
  const x0 = Math.ceil(minX / step) * step;
  for (let x = x0; x <= maxX; x += step) {
    objects.push({
      sym: 601000,
      otp: 2,
      coords: [
        [x, minY],
        [x, maxY],
      ],
    });
  }

  for (let p = 0; p < 4; p++) {
    const y0 = minY + 800 + p * 2200;
    const pts = [];
    for (let x = minX; x <= maxX; x += 1800) {
      pts.push([x, y0 + Math.round((rand() - 0.5) * 900)]);
    }
    objects.push({ sym: 505000, otp: 2, coords: pts });
  }

  const buf = assembleOcad({ fileType: 0, strings, symbols, objects });
  if (buf.length > MAX_SHOWCASE_BYTES) {
    throw new Error(`Showcase OCAD too large: ${buf.length} > ${MAX_SHOWCASE_BYTES}`);
  }
  return buf;
}

export function pgByteaLiteral(buf) {
  return `'\\x${buf.toString("hex")}'::bytea`;
}

const LEAK_PATTERNS = [
  /Vinter Flaten/i,
  /kartutsitt/i,
  /Skogsluffarna/i,
  /Delade enheter/i,
  /H:\\Delade/i,
];

export function assertShowcaseOcadClean(buf) {
  const text = buf.toString("latin1");
  for (const re of LEAK_PATTERNS) {
    if (re.test(text)) {
      throw new Error(`Showcase OCAD still contains identifying text matching ${re}`);
    }
  }
  if (buf.length > MAX_SHOWCASE_BYTES) {
    throw new Error(`Showcase OCAD too large: ${buf.length}`);
  }
  if (buf.readUInt16LE(0) !== 0x0cad) {
    throw new Error("Showcase OCAD missing 0x0CAD magic");
  }
}
