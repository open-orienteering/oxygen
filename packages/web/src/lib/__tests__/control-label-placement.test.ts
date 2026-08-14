/**
 * Unit tests for control-number label placement.
 *
 * The regression scenario is real: the 82/84 control cluster from the
 * "Ungdomsserien, regionfinal SO" event (H16 course), where the old
 * inline algorithm placed control 84's number closer to control 82's
 * circle than 82's own number — making the map read as if the left
 * circle were 84.
 *
 * Coordinates are in screen convention (y grows downward). The source
 * geometry is map millimetres (y up), so real-event fixtures negate y.
 */

import { describe, it, expect } from "vitest";
import {
  placeControlLabels,
  type PlacementCircle,
  type PlacementSeg,
} from "../control-label-placement";

/** Nominal overprint dimensions in map mm — same ratios MapViewer uses. */
const OPTS = { radius: 2.5, labelSize: 3.5 };

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

/** Distance from a point to the closest point of a placed label box. */
function rectEdgeDist(
  px: number,
  py: number,
  r: { x: number; y: number; w: number; h: number },
): number {
  const dx = Math.max(Math.abs(px - r.x) - r.w / 2, 0);
  const dy = Math.max(Math.abs(py - r.y) - r.h / 2, 0);
  return Math.hypot(dx, dy);
}

/**
 * The 82/84 cluster from Ungdomsserien regionfinal SO, H16 (course seq 8),
 * in screen coords (map-mm with y negated). Legs are the H16 sequence
 * through the cluster: 90→84→91→92→83→82→63.
 */
const CLUSTER: Record<string, { x: number; y: number }> = {
  "63": { x: 87.96, y: 12.99 },
  "90": { x: 115.38, y: 21.41 },
  "110": { x: 119.22, y: 27.01 },
  "64": { x: 110.64, y: 34.89 },
  "82": { x: 97.91, y: 40.68 },
  "84": { x: 108.71, y: 44.07 },
  "102": { x: 100.7, y: 46.34 },
  "91": { x: 116.94, y: 52.59 },
  "83": { x: 93.15, y: 52.07 },
  "92": { x: 96.1, y: 56.68 },
};

function clusterCircles(): PlacementCircle[] {
  return Object.entries(CLUSTER).map(([code, p]) => ({
    id: code,
    x: p.x,
    y: p.y,
    label: code,
  }));
}

function clusterLegs(): PlacementSeg[] {
  const seq = ["90", "84", "91", "92", "83", "82", "63"];
  const segs: PlacementSeg[] = [];
  for (let i = 0; i < seq.length - 1; i++) {
    const a = CLUSTER[seq[i]];
    const b = CLUSTER[seq[i + 1]];
    segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
  return segs;
}

describe("placeControlLabels", () => {
  it("places an isolated control's label up-right of the circle", () => {
    const placed = placeControlLabels(
      [{ id: "a", x: 100, y: 100, label: "31" }],
      [],
      OPTS,
    );
    const l = placed.get("a")!;
    expect(l).toBeDefined();
    expect(l.x).toBeGreaterThan(100);
    expect(l.y).toBeLessThan(100);
    expect(l.leader).toBeUndefined();
  });

  it("returns no entry for circles without a label (obstacles only)", () => {
    const placed = placeControlLabels(
      [
        { id: "a", x: 100, y: 100, label: "31" },
        { id: "finish", x: 130, y: 100 },
      ],
      [],
      OPTS,
    );
    expect(placed.has("a")).toBe(true);
    expect(placed.has("finish")).toBe(false);
  });

  it("avoids course lines passing the preferred side", () => {
    // Vertical line hugging the right side of the circle: the default
    // up-right slot must lose to a slot clear of the line.
    const placed = placeControlLabels(
      [{ id: "a", x: 100, y: 100, label: "31" }],
      [{ x1: 108, y1: 0, x2: 108, y2: 200 }],
      OPTS,
    );
    const l = placed.get("a")!;
    const estH = OPTS.labelSize * 1.2;
    expect(Math.abs(l.x - 108)).toBeGreaterThanOrEqual(estH);
  });

  it("attaches no leader lines when every label owns its circle (82/84 cluster)", () => {
    const placed = placeControlLabels(clusterCircles(), clusterLegs(), OPTS);
    for (const [id, label] of placed) {
      expect(label.leader, `label ${id} has an unexpected leader line`).toBeUndefined();
    }
  });

  it("no label intrudes on a foreign circle's claim radius (82/84 cluster)", () => {
    // Claim radius: the smallest center distance a circle's own label can
    // ever have. A foreign label inside it is guaranteed to misread.
    const claim = OPTS.radius + OPTS.labelSize * 0.2 + (OPTS.labelSize * 1.2) / 2;
    const placed = placeControlLabels(clusterCircles(), clusterLegs(), OPTS);
    for (const [id, label] of placed) {
      for (const [otherId, other] of Object.entries(CLUSTER)) {
        if (otherId === id) continue;
        expect(
          dist(label.x, label.y, other.x, other.y),
          `label ${id} intrudes on circle ${otherId}'s claim radius`,
        ).toBeGreaterThanOrEqual(claim);
      }
    }
  });

  it("keeps every label closest to its own circle (82/84 regression)", () => {
    const placed = placeControlLabels(clusterCircles(), clusterLegs(), OPTS);
    for (const [id, label] of placed) {
      const own = CLUSTER[id];
      const dOwn = dist(label.x, label.y, own.x, own.y);
      for (const [otherId, other] of Object.entries(CLUSTER)) {
        if (otherId === id) continue;
        const dOther = dist(label.x, label.y, other.x, other.y);
        expect(
          dOther,
          `label ${id} is closer to circle ${otherId} (${dOther.toFixed(2)}) than to its own circle (${dOwn.toFixed(2)})`,
        ).toBeGreaterThan(dOwn);
      }
    }
  });

  it("keeps 84's label farther from 82's circle than 82's own label", () => {
    // The literal user-visible symptom: reading the map, "82" must be the
    // nearest number to circle 82.
    const placed = placeControlLabels(clusterCircles(), clusterLegs(), OPTS);
    const l82 = placed.get("82")!;
    const l84 = placed.get("84")!;
    const c82 = CLUSTER["82"];
    expect(dist(l84.x, l84.y, c82.x, c82.y)).toBeGreaterThan(
      dist(l82.x, l82.y, c82.x, c82.y),
    );
  });

  it("produces non-overlapping labels in the congested cluster", () => {
    const placed = placeControlLabels(clusterCircles(), clusterLegs(), OPTS);
    const entries = [...placed.values()];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        const overlapX =
          Math.abs(a.x - b.x) < (a.w + b.w) / 2;
        const overlapY =
          Math.abs(a.y - b.y) < (a.h + b.h) / 2;
        expect(overlapX && overlapY).toBe(false);
      }
    }
  });

  it("never places a label on top of a foreign circle", () => {
    const placed = placeControlLabels(clusterCircles(), clusterLegs(), OPTS);
    for (const [id, label] of placed) {
      for (const [otherId, other] of Object.entries(CLUSTER)) {
        if (otherId === id) continue;
        expect(
          dist(label.x, label.y, other.x, other.y),
          `label ${id} sits on circle ${otherId}`,
        ).toBeGreaterThan(OPTS.radius);
      }
    }
  });

  it("is scale-invariant: zooming does not change relative placement", () => {
    const scale = 4.7;
    const base = placeControlLabels(clusterCircles(), clusterLegs(), OPTS);
    const scaled = placeControlLabels(
      clusterCircles().map((c) => ({ ...c, x: c.x * scale, y: c.y * scale })),
      clusterLegs().map((s) => ({
        x1: s.x1 * scale,
        y1: s.y1 * scale,
        x2: s.x2 * scale,
        y2: s.y2 * scale,
      })),
      { radius: OPTS.radius * scale, labelSize: OPTS.labelSize * scale },
    );
    for (const [id, l] of base) {
      const s = scaled.get(id)!;
      expect(s.x / scale).toBeCloseTo(l.x, 6);
      expect(s.y / scale).toBeCloseTo(l.y, 6);
      expect(s.leader === undefined).toBe(l.leader === undefined);
      if (l.leader && s.leader) {
        expect(s.leader.x1 / scale).toBeCloseTo(l.leader.x1, 6);
        expect(s.leader.y1 / scale).toBeCloseTo(l.leader.y1, 6);
        expect(s.leader.x2 / scale).toBeCloseTo(l.leader.x2, 6);
        expect(s.leader.y2 / scale).toBeCloseTo(l.leader.y2, 6);
      }
    }
  });

  it("is deterministic regardless of input order", () => {
    const a = placeControlLabels(clusterCircles(), clusterLegs(), OPTS);
    const b = placeControlLabels(
      [...clusterCircles()].reverse(),
      clusterLegs(),
      OPTS,
    );
    for (const [id, l] of a) {
      expect(b.get(id)).toEqual(l);
    }
  });

  it("places every label at the same edge gap regardless of digit count", () => {
    // Coherence rule: an isolated "8" and an isolated "108" both sit with
    // their box edge exactly gap away from the circle edge.
    const gap = OPTS.labelSize * 0.2;
    for (const label of ["8", "108"]) {
      const placed = placeControlLabels(
        [{ id: "a", x: 100, y: 100, label }],
        [],
        OPTS,
      );
      const l = placed.get("a")!;
      const edge = rectEdgeDist(100, 100, l) - OPTS.radius;
      expect(edge).toBeCloseTo(gap, 6);
    }
  });

  it("honours per-circle radius overrides (finish double ring)", () => {
    // A finish ring right of the control: with the bigger radius the label
    // must not sit inside the finish's outer ring.
    const finishOuter = 3.0;
    const placed = placeControlLabels(
      [
        { id: "a", x: 100, y: 100, label: "100" },
        { id: "fin", x: 110, y: 100, radius: finishOuter },
      ],
      [],
      OPTS,
    );
    const l = placed.get("a")!;
    expect(dist(l.x, l.y, 110, 100)).toBeGreaterThan(finishOuter);
  });
});

/**
 * The ordinal-1 controls of Ungdomsserien regionfinal SO, in screen
 * coords (map-mm, y negated). Real DB geometry. This is the second
 * reported regression: 95's number sat on 73's circle, 87's and 108's
 * numbers collided, 106's number drifted needlessly far out. The
 * cluster is genuinely hard — the circles of 87/88, 87/108, 62/70 and
 * 70/106 physically overlap each other (closer than 2·radius).
 *
 * The Controls page draws no legs, so there are no line obstacles.
 */
const ORDINAL1: Record<string, { x: number; y: number }> = {
  "61": { x: 109.94, y: -2.28 },
  "62": { x: 114.43, y: 4.16 },
  "70": { x: 113.85, y: 7.54 },
  "71": { x: 99.85, y: -1.28 },
  "73": { x: 101.51, y: 3.26 },
  "87": { x: 102.8, y: 13.32 },
  "88": { x: 99.99, y: 13.32 },
  "95": { x: 107.45, y: 4.77 },
  "106": { x: 114.15, y: 10.92 },
  "108": { x: 106.66, y: 12.24 },
};

function ordinal1Circles(): PlacementCircle[] {
  return Object.entries(ORDINAL1).map(([code, p]) => ({
    id: code,
    x: p.x,
    y: p.y,
    label: code,
  }));
}

describe("placeControlLabels — ordinal-1 cluster regressions", () => {
  const placed = placeControlLabels(ordinal1Circles(), [], OPTS);

  it("places all ten labels", () => {
    expect(placed.size).toBe(10);
  });

  it("no label box intersects any circle (95-on-73 regression)", () => {
    for (const [id, label] of placed) {
      for (const [otherId, other] of Object.entries(ORDINAL1)) {
        if (otherId === id) continue;
        expect(
          rectEdgeDist(other.x, other.y, label),
          `label ${id}'s box overlaps circle ${otherId}`,
        ).toBeGreaterThan(OPTS.radius);
      }
    }
  });

  it("no two label boxes intersect (87/108 regression)", () => {
    const entries = [...placed.entries()];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [idA, a] = entries[i];
        const [idB, b] = entries[j];
        const overlaps =
          Math.abs(a.x - b.x) < (a.w + b.w) / 2 &&
          Math.abs(a.y - b.y) < (a.h + b.h) / 2;
        expect(overlaps, `labels ${idA} and ${idB} overlap`).toBe(false);
      }
    }
  });

  it("every label sits on a quantized ring, nearly all on the first (106 regression)", () => {
    const gap = OPTS.labelSize * 0.2;
    let beyondFirst = 0;
    for (const [id, label] of placed) {
      const own = ORDINAL1[id];
      const edge = rectEdgeDist(own.x, own.y, label) - OPTS.radius;
      // Edge clearance must be exactly gap + k·(labelSize/2) for a small
      // integer k: labels never drift to arbitrary distances.
      const k = (edge - gap) / (OPTS.labelSize / 2);
      expect(
        Math.abs(k - Math.round(k)),
        `label ${id} sits at a non-ring clearance ${edge.toFixed(3)}`,
      ).toBeLessThan(1e-6);
      expect(Math.round(k)).toBeGreaterThanOrEqual(0);
      expect(Math.round(k)).toBeLessThanOrEqual(4);
      if (Math.round(k) > 0) beyondFirst++;
    }
    // 106 drifting out was the reported regression: it must be on the
    // innermost ring. Only 95 — fully enclosed by six circles — may
    // legitimately need a wider ring.
    const gap106 =
      rectEdgeDist(ORDINAL1["106"].x, ORDINAL1["106"].y, placed.get("106")!) -
      OPTS.radius;
    expect(gap106).toBeCloseTo(gap, 6);
    expect(beyondFirst).toBeLessThanOrEqual(1);
  });

  it("only the geometrically-forced 95 may intrude on a foreign claim radius", () => {
    // For every circle here the claim radius is radius + gap + halfH.
    // Brute-force scanning shows every collision-free slot for 95 either
    // intrudes on a neighbour's claim or lies ≥ 9.16 mm out, so 95 is
    // exempt; everyone else must stay outside all foreign claims.
    const claim = OPTS.radius + OPTS.labelSize * 0.2 + (OPTS.labelSize * 1.2) / 2;
    for (const [id, label] of placed) {
      if (id === "95") continue;
      for (const [otherId, other] of Object.entries(ORDINAL1)) {
        if (otherId === id) continue;
        expect(
          dist(label.x, label.y, other.x, other.y),
          `label ${id} intrudes on circle ${otherId}'s claim radius`,
        ).toBeGreaterThanOrEqual(claim);
      }
    }
  });

  it("gives the contested 95 a leader line to its own circle, nobody else", () => {
    for (const [id, label] of placed) {
      if (id !== "95") {
        expect(label.leader, `label ${id} has an unexpected leader line`).toBeUndefined();
      }
    }
    const own = ORDINAL1["95"];
    const l = placed.get("95")!;
    const leader = l.leader!;
    expect(leader).toBeDefined();
    // Circle-side endpoint sits exactly on the own circle's edge.
    expect(dist(leader.x2, leader.y2, own.x, own.y)).toBeCloseTo(OPTS.radius, 6);
    // Label-side endpoint sits inside the box (pulled in from the
    // boundary so the tick visually connects with the digits).
    expect(rectEdgeDist(leader.x1, leader.y1, l)).toBeCloseTo(0, 6);
  });

  it("keeps 95 in the nearby pocket instead of exiling it outward", () => {
    // The closest collision-free slot that intrudes on no claim radius is
    // ~9.16 mm out (razor-thin, tangent to circle 73); the chosen pocket
    // at ~9.5 mm is the practical optimum. Treating claim intrusion as a
    // hard constraint used to push 95 past 11.5 mm — this guards that.
    const label = placed.get("95")!;
    const own = ORDINAL1["95"];
    expect(dist(label.x, label.y, own.x, own.y)).toBeLessThan(10);
  });

  it("gives every circle except enclosed 95 its own label as nearest", () => {
    // 95 is surrounded by six circles within 7.5 mm — every collision-free
    // pocket is nearer to some neighbour, so it is exempt. Everyone else
    // must read unambiguously: the nearest label to a circle is its own.
    for (const [id, label] of placed) {
      if (id === "95") continue;
      const own = ORDINAL1[id];
      const dOwn = dist(label.x, label.y, own.x, own.y);
      for (const [otherId, other] of Object.entries(ORDINAL1)) {
        if (otherId === id) continue;
        expect(
          dist(label.x, label.y, other.x, other.y),
          `label ${id} is closer to circle ${otherId} than to its own`,
        ).toBeGreaterThan(dOwn);
      }
    }
  });
});
