/**
 * Unit tests for multi-course leg label placement: control-pair keying
 * (one label per leg, no repeats), shared-leg merging, centering, upright
 * rotation (incl. rotated map layers), and the class-list label text.
 */

import { describe, it, expect } from "vitest";
import {
  uprightAngle,
  buildCourseLegLabels,
  courseLegLabelText,
  pillHalfWidth,
  type Pt,
} from "../course-leg-labels";

describe("uprightAngle", () => {
  it("keeps readable angles unchanged and flips upside-down ones", () => {
    expect(uprightAngle(30)).toBe(30);
    expect(uprightAngle(-60)).toBe(-60);
    expect(uprightAngle(135)).toBe(-45);
    expect(uprightAngle(-135)).toBe(45);
    expect(uprightAngle(180)).toBe(0);
  });

  it("judges uprightness in screen space on a rotated map layer", () => {
    // Layer angle 80° + map rotation 30° = 110° on screen → flip by 180°.
    expect(uprightAngle(80, 30)).toBe(80 - 180);
    // Layer angle 80° with no rotation stays.
    expect(uprightAngle(80, 0)).toBe(80);
  });
});

describe("buildCourseLegLabels", () => {
  const positions = new Map<string, Pt>([
    ["S", { x: 0, y: 300 }],
    ["31", { x: 0, y: 0 }],
    ["32", { x: 300, y: 0 }],
    ["33", { x: 300, y: 300 }],
  ]);
  const opts = { baseFontSize: 11, minFontSize: 5 };

  it("places exactly one centered label per leg at the base size", () => {
    const labels = buildCourseLegLabels(
      [{ text: "Öppen 1", controlIds: ["31", "32"] }],
      positions,
      opts,
    );
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      x: 150,
      y: 0,
      angleDeg: 0,
      text: "Öppen 1",
      fontSize: 11,
    });
  });

  it("merges legs shared between courses into one label with all classes", () => {
    const labels = buildCourseLegLabels(
      [
        { text: "Öppen 2", controlIds: ["31", "32", "33"] },
        // Same first leg, traversed the other way, plus a leg of its own.
        { text: "Öppen 1", controlIds: ["32", "31", "S"] },
      ],
      positions,
      opts,
    );
    const byText = new Map(labels.map((l) => [`${l.x},${l.y}`, l.text]));
    expect(byText.get("150,0")).toBe("Öppen 1, Öppen 2");
    expect(byText.get("300,150")).toBe("Öppen 2");
    expect(byText.get("0,150")).toBe("Öppen 1");
    expect(labels).toHaveLength(3);
  });

  it("dedupes classes when merged texts overlap", () => {
    const labels = buildCourseLegLabels(
      [
        { text: "Öppen 1, Öppen 2", controlIds: ["31", "32"] },
        { text: "Öppen 2, Öppen 3", controlIds: ["31", "32"] },
      ],
      positions,
      opts,
    );
    expect(labels).toHaveLength(1);
    expect(labels[0].text).toBe("Öppen 1, Öppen 2, Öppen 3");
  });

  it("never repeats a label when a course visits the same pair twice (butterfly)", () => {
    const labels = buildCourseLegLabels(
      [{ text: "Öppen 1", controlIds: ["31", "32", "31", "32"] }],
      positions,
      opts,
    );
    expect(labels).toHaveLength(1);
  });

  it("shrinks a label that would be longer than its leg until it fits", () => {
    // 16 chars over 100px: at 11px the text needs ~131px → must shrink.
    const tight = new Map<string, Pt>([
      ["31", { x: 0, y: 0 }],
      ["32", { x: 100, y: 0 }],
    ]);
    const labels = buildCourseLegLabels(
      [
        { text: "Öppen 1", controlIds: ["31", "32"] },
        { text: "Öppen 2", controlIds: ["32", "31"] },
      ],
      tight,
      opts,
    );
    expect(labels).toHaveLength(1);
    const l = labels[0];
    expect(l.text).toBe("Öppen 1, Öppen 2");
    expect(l.fontSize).toBeLessThan(11);
    expect(l.fontSize).toBeGreaterThanOrEqual(5);
    // The shrunk PILL (not just the text) actually fits the 100px leg.
    expect(pillHalfWidth(l.text.length, l.fontSize) * 2).toBeLessThanOrEqual(100.001);
  });

  it("fits and centers the pill on the visible span between circle edges", () => {
    // Leg (0,0)→(300,0); big finish circle at B (clearance 60), regular
    // control at A (clearance 20): visible line runs 20..240.
    const labels = buildCourseLegLabels(
      [{ text: "Öppen 1", controlIds: ["31", "32"] }],
      positions,
      {
        ...opts,
        clearance: (id) => (id === "32" ? 60 : 20),
      },
    );
    expect(labels).toHaveLength(1);
    const l = labels[0];
    // Centered on the visible span: (20 + 240) / 2 = 130, not 150.
    expect(l.x).toBeCloseTo(130);
    expect(l.y).toBeCloseTo(0);
    // And the pill fits within the 220px visible span.
    expect(pillHalfWidth(l.text.length, l.fontSize) * 2).toBeLessThanOrEqual(220.001);
  });

  it("drops a label when circle clearances swallow the whole leg", () => {
    const short = new Map<string, Pt>([
      ["31", { x: 0, y: 0 }],
      ["32", { x: 50, y: 0 }],
    ]);
    const labels = buildCourseLegLabels(
      [{ text: "Ö", controlIds: ["31", "32"] }],
      short,
      { ...opts, clearance: () => 30 },
    );
    expect(labels).toHaveLength(0);
  });

  it("drops a label whose fitting size would fall below the minimum", () => {
    const tiny = new Map<string, Pt>([
      ["31", { x: 0, y: 0 }],
      ["32", { x: 40, y: 0 }],
    ]);
    const labels = buildCourseLegLabels(
      [{ text: "A very long class list label", controlIds: ["31", "32"] }],
      tiny,
      opts,
    );
    expect(labels).toHaveLength(0);
  });

  it("ignores controls without known positions and degenerate legs", () => {
    const labels = buildCourseLegLabels(
      [{ text: "Öppen 1", controlIds: ["31", "missing", "32", "32"] }],
      positions,
      opts,
    );
    expect(labels).toHaveLength(0);
  });

  it("rotates labels along the leg, kept upright", () => {
    const labels = buildCourseLegLabels(
      [{ text: "Öppen 1", controlIds: ["32", "31"] }], // pointing west (180°)
      positions,
      opts,
    );
    expect(labels[0].angleDeg).toBe(0); // flipped upright
  });
});

describe("courseLegLabelText", () => {
  it("joins all classes sharing the course, numerically sorted", () => {
    expect(courseLegLabelText("Bana 1", ["Öppen 10", "Öppen 2"])).toBe(
      "Öppen 2, Öppen 10",
    );
  });

  it("falls back to the course name without classes", () => {
    expect(courseLegLabelText("Bana 1", [])).toBe("Bana 1");
    expect(courseLegLabelText("Bana 1", undefined)).toBe("Bana 1");
  });
});
