import { describe, it, expect } from "vitest";
import {
  encodeBitmapAsStarRaster,
  buildStarRasterTestPattern,
  STAR_RASTER_WIDTH_DOTS,
} from "../receipt-printer/star-raster.js";

const hex = (b: Uint8Array) =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join(" ");

const PROLOGUE_INIT = "1b 40";
const PROLOGUE_RASTER = "1b 2a 72 52 1b 2a 72 41";
const CUT_PARTIAL = "1b 2a 72 45 31 33 00";
const CUT_FULL = "1b 2a 72 45 39 00";
const END_PAGE = "1b 2a 72 59 31 00 1b 0c";
const END_JOB = "04 1b 2a 72 42";

describe("encodeBitmapAsStarRaster — prologue", () => {
  it("emits init + raster mode + partial cut config when cut='partial'", () => {
    const out = encodeBitmapAsStarRaster(
      { widthBytes: 1, heightDots: 0, data: new Uint8Array(0) },
      { cut: "partial" },
    );
    const dump = hex(out);
    expect(dump.startsWith(`${PROLOGUE_INIT} ${PROLOGUE_RASTER} ${CUT_PARTIAL}`)).toBe(true);
  });

  it("emits full-cut config when cut='full'", () => {
    const out = encodeBitmapAsStarRaster(
      { widthBytes: 1, heightDots: 0, data: new Uint8Array(0) },
      { cut: "full" },
    );
    expect(hex(out).includes(CUT_FULL)).toBe(true);
    expect(hex(out).includes(CUT_PARTIAL)).toBe(false);
  });

  it("omits the cut config bytes entirely when cut='none'", () => {
    const out = encodeBitmapAsStarRaster(
      { widthBytes: 1, heightDots: 0, data: new Uint8Array(0) },
      { cut: "none" },
    );
    expect(hex(out).includes(CUT_PARTIAL)).toBe(false);
    expect(hex(out).includes(CUT_FULL)).toBe(false);
  });

  it("defaults cut to partial", () => {
    const out = encodeBitmapAsStarRaster({ widthBytes: 1, heightDots: 0, data: new Uint8Array(0) });
    expect(hex(out).includes(CUT_PARTIAL)).toBe(true);
  });
});

describe("encodeBitmapAsStarRaster — epilogue", () => {
  it("always ends with the endPage form-feed and endJob batch", () => {
    const out = encodeBitmapAsStarRaster({ widthBytes: 1, heightDots: 0, data: new Uint8Array(0) });
    const dump = hex(out);
    expect(dump.endsWith(`${END_PAGE} ${END_JOB}`)).toBe(true);
  });
});

describe("encodeBitmapAsStarRaster — single data line", () => {
  it("matches the verified hand-test for a 9-byte black bar (paper-economy correct)", () => {
    const data = new Uint8Array(9).fill(0xff);
    const out = encodeBitmapAsStarRaster(
      { widthBytes: 9, heightDots: 1, data },
      { cut: "partial" },
    );
    // Expected sequence:
    //   prologue + cut config
    //   data:   62 09 00 ff ff ff ff ff ff ff ff ff
    //   endPage + endJob
    expect(hex(out)).toBe(
      [
        PROLOGUE_INIT,
        PROLOGUE_RASTER,
        CUT_PARTIAL,
        "62 09 00 ff ff ff ff ff ff ff ff ff",
        END_PAGE,
        END_JOB,
      ].join(" "),
    );
  });
});

describe("encodeBitmapAsStarRaster — blank-line compression", () => {
  it("compresses leading blank rows into a single ESC *rY skip with ASCII count", () => {
    // 5 blank rows then a single byte of data row, width 1.
    const data = new Uint8Array(6); // row 5 will be set
    data[5] = 0xab;
    const out = encodeBitmapAsStarRaster({ widthBytes: 1, heightDots: 6, data });
    const dump = hex(out);
    // ESC *rY 5 00 = 1b 2a 72 59 35 00, then b 01 00 ab
    expect(dump.includes("1b 2a 72 59 35 00 62 01 00 ab")).toBe(true);
  });

  it("uses multi-digit ASCII counts", () => {
    // 12 blank rows then a single data row.
    const data = new Uint8Array(13);
    data[12] = 0x80;
    const out = encodeBitmapAsStarRaster({ widthBytes: 1, heightDots: 13, data });
    const dump = hex(out);
    // ESC *rY '1' '2' 00 = 1b 2a 72 59 31 32 00
    expect(dump.includes("1b 2a 72 59 31 32 00 62 01 00 80")).toBe(true);
  });

  it("drops trailing blank rows after the last data row (endPage handles cutter offset)", () => {
    // 1 data row then 50 blank rows. The trailing blanks should NOT
    // generate an ESC *rY — they're absorbed by the form-feed at endPage.
    const heightDots = 51;
    const data = new Uint8Array(heightDots);
    data[0] = 0xff;
    const out = encodeBitmapAsStarRaster({ widthBytes: 1, heightDots, data });
    const dump = hex(out);
    // After "62 01 00 ff" we should jump straight to endPage, no ESC *rY
    expect(dump.includes("62 01 00 ff " + END_PAGE)).toBe(true);
  });
});

describe("encodeBitmapAsStarRaster — len encoding", () => {
  it("uses binary little-endian len_lo/len_hi for 'b' lines, not ASCII", () => {
    // A row with the very first byte set: lastNonZero = 0, len = 1
    const data = new Uint8Array([0x80]);
    const out = encodeBitmapAsStarRaster({ widthBytes: 1, heightDots: 1, data });
    expect(hex(out).includes("62 01 00 80")).toBe(true);
  });

  it("computes lastBlackPixel + 1 — trailing zero bytes are not emitted", () => {
    // 4-byte row with only the second byte set: lastNonZero = 1, len = 2
    const data = new Uint8Array([0x00, 0x42, 0x00, 0x00]);
    const out = encodeBitmapAsStarRaster({ widthBytes: 4, heightDots: 1, data });
    expect(hex(out).includes("62 02 00 00 42")).toBe(true);
  });
});

describe("encodeBitmapAsStarRaster — validation", () => {
  it("rejects widthBytes <= 0", () => {
    expect(() =>
      encodeBitmapAsStarRaster({ widthBytes: 0, heightDots: 1, data: new Uint8Array(0) }),
    ).toThrow(/positive/);
  });

  it("rejects widthBytes greater than 72 (TSP100 max)", () => {
    expect(() =>
      encodeBitmapAsStarRaster({ widthBytes: 73, heightDots: 1, data: new Uint8Array(73) }),
    ).toThrow(/exceeds/);
  });

  it("rejects mismatched data length", () => {
    expect(() =>
      encodeBitmapAsStarRaster({ widthBytes: 4, heightDots: 2, data: new Uint8Array(7) }),
    ).toThrow(/data length/);
  });
});

describe("buildStarRasterTestPattern", () => {
  it("matches the bytes our hand-test verified to print correctly", () => {
    const out = buildStarRasterTestPattern();
    expect(hex(out)).toBe(
      [
        PROLOGUE_INIT,
        PROLOGUE_RASTER,
        CUT_PARTIAL,
        "62 09 00 ff ff ff ff ff ff ff ff ff",
        END_PAGE,
        END_JOB,
      ].join(" "),
    );
  });
});

describe("STAR_RASTER_WIDTH_DOTS constant", () => {
  it("is 576 (72 mm at 203 dpi for TSP100)", () => {
    expect(STAR_RASTER_WIDTH_DOTS).toBe(576);
  });
});
