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
