/**
 * Hand-built pass streams for the render harness. Each fixture exercises
 * one aspect of the contract; backends must draw all of them identically
 * (within the golden-image tolerance). Coordinates are paper µm, y-up.
 *
 * Colour indices used here follow the ISOM demo stack in
 * `fixtureColours`: 0 white, 1 yellow, 2 green, 3 brown, 4 blue, 5 black,
 * 6 purple (upper), 7 purple (lower). Lower index = drawn first.
 */

import type { PassStreamJson } from "../../stream-json.js";

export const fixtureColours: Record<number, string> = {
  0: "#ffffff",
  1: "#ffba35",
  2: "#3cb54a",
  3: "#d15c00",
  4: "#00a3e0",
  5: "#000000",
  6: "#c800c8",
  7: "#c800c8",
};

/** Area with two holes; the fill rule must leave the holes white. */
export const fillWithHoles: PassStreamJson = {
  objectIdx: [0],
  symbolIdx: [401],
  passes: [
    {
      kind: "fill",
      colour: 1,
      path: {
        // outer 20 mm square, hole 4 mm square at (4,4), hole 3 mm at (12,12)
        coords: [
          0, 0, 20000, 0, 20000, 20000, 0, 20000,
          4000, 4000, 8000, 4000, 8000, 8000, 4000, 8000,
          12000, 12000, 15000, 12000, 15000, 15000, 12000, 15000,
        ],
        flags: [0, 0, 0, 0, 16, 0, 0, 0, 16, 0, 0, 0],
        closed: true,
      },
    },
  ],
};

/** A Bézier S-curve stroked whole, and the same curve dashed via slices. */
export const dashedBezierStroke: PassStreamJson = {
  objectIdx: [0, 1],
  symbolIdx: [503, 505],
  passes: [
    {
      kind: "stroke",
      colour: 3,
      path: {
        coords: [0, 0, 6000, 12000, 14000, -12000, 20000, 0],
        flags: [0, 1, 2, 0],
      },
      widthUm: 350,
      cap: "butt",
      join: "round",
    },
    {
      kind: "stroke",
      colour: 5,
      path: {
        coords: [0, 4000, 6000, 16000, 14000, -8000, 20000, 4000],
        flags: [0, 1, 2, 0],
      },
      slices: [
        { seg0: 0, t0: 0, seg1: 0, t1: 0.2 },
        { seg0: 0, t0: 0.3, seg1: 0, t1: 0.5 },
        { seg0: 0, t0: 0.6, seg1: 0, t1: 0.8 },
        { seg0: 0, t0: 0.9, seg1: 0, t1: 1 },
      ],
      widthUm: 500,
      cap: "butt",
      join: "miter",
    },
  ],
};

/** One glyph with two colour parts, instanced with rotation and scale. */
export const glyphInstances: PassStreamJson = {
  objectIdx: [0, 0, 1, 1],
  symbolIdx: [418, 418, 418, 418],
  passes: [
    { kind: "glyph", colour: 2, glyphId: 1, partIdx: 0, instances: [5000, 5000, 1, 0, 1] },
    { kind: "glyph", colour: 5, glyphId: 1, partIdx: 1, instances: [5000, 5000, 1, 0, 1] },
    {
      kind: "glyph", colour: 2, glyphId: 1, partIdx: 0,
      instances: [15000, 5000, 0.7071, 0.7071, 1.5, 10000, 15000, 1, 0, 0.75],
    },
    {
      kind: "glyph", colour: 5, glyphId: 1, partIdx: 1,
      instances: [15000, 5000, 0.7071, 0.7071, 1.5, 10000, 15000, 1, 0, 0.75],
    },
  ],
  glyphTable: [
    {
      glyphId: 1,
      partIdx: 0,
      // green triangle, 2 mm tall, pointing +y
      fills: [{ coords: [-1000, -800, 1000, -800, 0, 1200], closed: true }],
      strokes: [],
    },
    {
      glyphId: 1,
      partIdx: 1,
      // black stem under it
      fills: [],
      strokes: [{ path: { coords: [0, -800, 0, -1600] }, widthUm: 250, cap: "butt", join: "miter" }],
    },
  ],
};

/** Hatched area with an angle and an offset, clipped to a pentagon. */
export const hatchArea: PassStreamJson = {
  objectIdx: [0],
  symbolIdx: [408],
  passes: [
    {
      kind: "hatch",
      colour: 2,
      path: {
        coords: [0, 0, 20000, 2000, 24000, 14000, 10000, 22000, -2000, 12000],
        closed: true,
      },
      widthUm: 250,
      spacingUm: 1000,
      offsetUm: 250,
      angleDeg: 45,
    },
  ],
};

/**
 * Overlapping passes pushed in the wrong order; the sort must put the
 * yellow fill under the brown stroke under the black glyph under purple.
 */
export const colourOrder: PassStreamJson = {
  objectIdx: [3, 2, 1, 0, 4],
  symbolIdx: [701, 502, 401, 418, 503],
  passes: [
    {
      kind: "stroke",
      colour: 6,
      path: { coords: [0, 10000, 20000, 10000] },
      widthUm: 600,
      cap: "butt",
      join: "miter",
    },
    {
      kind: "stroke",
      colour: 3,
      path: { coords: [10000, 0, 10000, 20000] },
      widthUm: 1000,
      cap: "butt",
      join: "miter",
    },
    {
      kind: "fill",
      colour: 1,
      path: { coords: [2000, 2000, 18000, 2000, 18000, 18000, 2000, 18000], closed: true },
    },
    { kind: "glyph", colour: 5, glyphId: 7, partIdx: 0, instances: [10000, 10000, 1, 0, 1] },
    {
      kind: "stroke",
      colour: 3,
      path: { coords: [0, 0, 20000, 20000] },
      widthUm: 350,
      cap: "round",
      join: "round",
    },
  ],
  glyphTable: [
    {
      glyphId: 7,
      partIdx: 0,
      fills: [{ coords: [-1500, -1500, 1500, -1500, 1500, 1500, -1500, 1500], closed: true }],
      strokes: [],
    },
  ],
};

/** Text with a halo pass under it; drawn as em boxes until fonts land. */
export const textWithHalo: PassStreamJson = {
  objectIdx: [0, 0],
  symbolIdx: [710, 710],
  passes: [
    {
      kind: "text", colour: 0, fontId: 0, sizeUm: 3000,
      glyphs: [36, 37, 38], positions: [1000, 5000, 3000, 5000, 5000, 5000],
      haloWidthUm: 200,
    },
    {
      kind: "text", colour: 5, fontId: 0, sizeUm: 3000,
      glyphs: [36, 37, 38], positions: [1000, 5000, 3000, 5000, 5000, 5000],
    },
  ],
  fontTable: [{ fontId: 0, family: "liberation-sans", bold: false, italic: false }],
};

export const renderFixtures = {
  "fill-with-holes": fillWithHoles,
  "dashed-bezier-stroke": dashedBezierStroke,
  "glyph-instances": glyphInstances,
  "hatch-area": hatchArea,
  "colour-order": colourOrder,
  "text-with-halo": textWithHalo,
} as const satisfies Record<string, PassStreamJson>;

export type RenderFixtureName = keyof typeof renderFixtures;
