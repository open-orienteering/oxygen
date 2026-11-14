import { describe, expect, it } from "vitest";
import { evidenceContext, formTickEvidence, gatherEvidence, lakeEvidence, tickDirection, topEvidence } from "../index.js";
import { S, build, line, ring, tick, tickAngle } from "./fixtures.js";

/** Horizontal contours drawn eastwards: uphill to the north is their left (+1). */
const LADDER = [line(0, 5, 60, 5), line(0, 11, 60, 11), line(0, 17, 60, 17)];
const AREA: [number, number, number, number] = [0, 0, 60, 22];

describe("slope ticks (map-terrain.md §3.1)", () => {
  it("reads the glyph's +y turned counter-clockwise as downhill", () => {
    const [dx, dy] = tickDirection((tickAngle(0, -1) * Math.PI) / 1800);
    expect(dx).toBeCloseTo(0, 9);
    expect(dy).toBeCloseTo(-1, 9);
  });

  it("puts uphill on the side the tick does not point to", () => {
    const south = build([{ sym: S.contour, coords: LADDER[1] }, tick(30, 11, 0, -1)], AREA);
    expect(gatherEvidence(south.g).tick).toEqual([{ chain: 0, side: 1, weight: 4 }]);
    const north = build([{ sym: S.contour, coords: LADDER[1] }, tick(30, 11, 0, 1)], AREA);
    expect(gatherEvidence(north.g).tick).toEqual([{ chain: 0, side: -1, weight: 4 }]);
  });

  it("drops a tick along its contour and one off every contour", () => {
    const { g } = build([{ sym: S.contour, coords: LADDER[1] }, tick(30, 11, 1, 0), tick(30, 13, 0, -1)], AREA);
    expect(gatherEvidence(g).tick).toEqual([]);
  });
});

describe("tops (§3.1)", () => {
  it("takes the innermost closed contour for a top, by its orientation", () => {
    const ccw = build([{ sym: S.contour, coords: ring(30, 20, 5) }]);
    expect(topEvidence(ccw.g)).toEqual([{ chain: 0, side: 1, weight: 2 }]);
    const cw = ring(30, 20, 5);
    const rev: number[] = [];
    for (let i = cw.length - 2; i >= 0; i -= 2) rev.push(cw[i], cw[i + 1]);
    const clockwise = build([{ sym: S.contour, coords: rev }]);
    expect(topEvidence(clockwise.g)).toEqual([{ chain: 0, side: -1, weight: 2 }]);
  });

  it("does not take a ring holding another chain", () => {
    const { g, chain } = build([{ sym: S.contour, coords: ring(30, 20, 10) }, { sym: S.contour, coords: ring(30, 20, 5) }]);
    expect(topEvidence(g).map((e) => e.chain)).toEqual([chain(1)]);
  });
});

describe("tagged cliffs (§3.1)", () => {
  it("votes on the contours on both sides of a cliff between them", () => {
    const { g, chain } = build(
      [
        { sym: S.contour, coords: LADDER[0] },
        { sym: S.contour, coords: line(0, 9, 60, 9) },
        // drawn eastwards with ISOM's tags on the right: they point south, downhill
        { sym: S.cliffTagged, coords: line(20, 7, 40, 7) },
      ],
      AREA,
    );
    expect(g.inputs.cliffs[0].tagSide).toBe(-1);
    const ev = gatherEvidence(g).cliff.sort((a, b) => a.chain - b.chain);
    expect(ev).toEqual([
      { chain: Math.min(chain(0), chain(1)), side: 1, weight: 1.5 },
      { chain: Math.max(chain(0), chain(1)), side: 1, weight: 1.5 },
    ]);
  });

  it("votes on a contour it is drawn on, and on that contour alone", () => {
    const { g, chain } = build(
      [
        { sym: S.contour, coords: LADDER[0] },
        { sym: S.contour, coords: LADDER[1] },
        { sym: S.cliffTagged, coords: line(20, 11.2, 40, 11.2) },
      ],
      AREA,
    );
    expect(gatherEvidence(g).cliff).toEqual([{ chain: chain(1), side: 1, weight: 1.5 }]);
  });
});

describe("lakes (§3.1)", () => {
  it("puts the contour a lake looks at above it", () => {
    const { g } = build([{ sym: S.contour, coords: ring(30, 20, 8) }, { sym: S.water, coords: ring(30, 20, 4) }]);
    // the ring is counter-clockwise: the lake (inside) is its left, so uphill is right
    expect(lakeEvidence(evidenceContext(g))).toEqual([{ chain: 0, side: -1, weight: 1.5 }]);
  });

  it("skips a lake under 2 mm²", () => {
    const { g } = build([{ sym: S.contour, coords: ring(30, 20, 8) }, { sym: S.water, coords: ring(30, 20, 0.6) }]);
    expect(lakeEvidence(evidenceContext(g))).toEqual([]);
  });
});

describe("form-line ticks (§3.1)", () => {
  it("vote on the contours either side of an open form line", () => {
    const { g, chain } = build(
      [{ sym: S.contour, coords: LADDER[0] }, { sym: S.contour, coords: LADDER[1] }, { sym: S.form, coords: line(10, 8, 50, 8) }, { sym: S.formTick, coords: [30, 8], angleDeciDeg: tickAngle(0, -1) }],
      AREA,
    );
    const ev = formTickEvidence(evidenceContext(g)).sort((a, b) => a.chain - b.chain);
    expect(ev).toEqual([
      { chain: Math.min(chain(0), chain(1)), side: 1, weight: 1.5 },
      { chain: Math.max(chain(0), chain(1)), side: 1, weight: 1.5 },
    ]);
  });

  it("are dropped on a closed form line and where the ray crosses another form line", () => {
    const closed = build([{ sym: S.contour, coords: ring(30, 20, 10) }, { sym: S.form, coords: ring(30, 20, 3) }, { sym: S.formTick, coords: [33, 20], angleDeciDeg: tickAngle(1, 0) }]);
    expect(formTickEvidence(evidenceContext(closed.g))).toEqual([]);
    const crossed = build(
      [
        { sym: S.contour, coords: LADDER[0] },
        { sym: S.contour, coords: LADDER[1] },
        { sym: S.form, coords: line(10, 8, 50, 8) },
        { sym: S.form, coords: line(10, 7, 50, 7) },
        { sym: S.formTick, coords: [30, 8], angleDeciDeg: tickAngle(0, -1) },
      ],
      AREA,
    );
    // the downhill ray meets the second form line first: only the uphill contour is told
    expect(formTickEvidence(evidenceContext(crossed.g))).toEqual([{ chain: crossed.chain(1), side: 1, weight: 1.5 }]);
  });
});
