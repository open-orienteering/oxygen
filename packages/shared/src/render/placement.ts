/**
 * Glyph placement along lines (03 §6.9 item 3): where along the path a
 * line symbol's glyphs sit and at what angle. Output is a list of
 * `(lengthAlongPath, angleDeg, scale)`; the caller turns them into
 * instance transforms.
 */

import { COORD_FLAG } from "./pass-stream.js";
import { type Interval, gapsOf, layoutDashes } from "./dash.js";
import { type PathMeasure, type Section, pathSections } from "./measure.js";
import type { DashPattern, GlyphPlacement } from "./symbol.js";

export interface Placement {
  len: number;
  /** Tangent angle at `len`, degrees. */
  angleDeg: number;
  scale: number;
}

const deg = (tx: number, ty: number) => (Math.atan2(ty, tx) * 180) / Math.PI;

function tangentAngle(m: PathMeasure, len: number): number {
  const p = m.pointAt(len);
  return deg(p.tx, p.ty);
}

/** Angle bisecting the incoming and outgoing tangents at a split point. */
function cornerAngle(m: PathMeasure, len: number): { angleDeg: number; turnDeg: number } {
  const eps = Math.min(1, m.totalLength / 1000);
  const a = m.pointAt(Math.max(0, len - eps));
  const b = m.pointAt(Math.min(m.totalLength, len + eps));
  const ax = a.tx + b.tx, ay = a.ty + b.ty;
  const angleDeg = Math.hypot(ax, ay) < 1e-9 ? deg(a.tx, a.ty) : deg(ax, ay);
  const dot = Math.max(-1, Math.min(1, a.tx * b.tx + a.ty * b.ty));
  return { angleDeg, turnDeg: (Math.acos(dot) * 180) / Math.PI };
}

/** OMAP-style spaced placement in one section. */
function spacedInSection(
  sec: Section,
  p: Extract<GlyphPlacement, { at: "spaced" }>,
  closedPath: boolean,
): number[] {
  const L = sec.endLen - sec.startLen;
  const first = p.firstUm ?? p.distanceUm / 2;
  const last = p.lastUm ?? p.distanceUm / 2;
  const minCount = (sec.closedLoop || closedPath ? p.minCountClosed : undefined) ?? p.minCount ?? 0;
  const inner = L - first - last;
  let n: number;
  if (sec.closedLoop) {
    // No ends on a loop: spots every `distance`, count rounded, first spot at the start point.
    n = Math.max(minCount, Math.round(L / p.distanceUm));
    if (n <= 0) return [];
    const step = L / n;
    return Array.from({ length: n }, (_, i) => sec.startLen + i * step);
  }
  n = inner < 0 ? 0 : Math.round(inner / p.distanceUm) + 1;
  n = Math.max(n, minCount);
  if (n <= 0) return [];
  if (n === 1) return [sec.startLen + L / 2];
  const step = Math.max(0, inner) / (n - 1);
  const start = inner < 0 ? sec.startLen + L / 2 : sec.startLen + first;
  return Array.from({ length: n }, (_, i) => start + i * step);
}

export interface PlaceOptions {
  /** Dash pattern of the main stroke, for `dashCentres` / `gapCentres`. */
  dash?: DashPattern;
  scaleAtCorners?: boolean;
  rotatable: boolean;
}

export function placeGlyphs(m: PathMeasure, placement: GlyphPlacement, opts: PlaceOptions): Placement[] {
  const L = m.totalLength;
  if (L <= 0 || m.segments.length === 0) return [];
  const out: Placement[] = [];
  const at = (len: number, angleDeg?: number, scale = 1) =>
    out.push({ len, angleDeg: opts.rotatable ? (angleDeg ?? tangentAngle(m, len)) : 0, scale });
  const closed = m.path.closed;

  switch (placement.at) {
    case "start":
      at(0);
      break;
    case "end":
      at(L);
      break;
    case "corners":
    case "dashPoints": {
      const mask = placement.at === "corners" ? COORD_FLAG.corner : COORD_FLAG.dash;
      const lens = m.flaggedLengths(mask).filter((l) => l > 0 && l < L);
      if (!placement.ignoreEnds && !closed) {
        at(0);
      }
      for (const l of lens) {
        const c = cornerAngle(m, l);
        const scale = opts.scaleAtCorners ? 1 / Math.max(0.25, Math.cos((c.turnDeg * Math.PI) / 360)) : 1;
        at(l, c.angleDeg, scale);
      }
      if (!placement.ignoreEnds && !closed) at(L);
      if (closed && (m.path.flags[0] & mask)) at(0, cornerAngle(m, 0).angleDeg);
      break;
    }
    case "dashCentres":
    case "gapCentres": {
      if (!opts.dash) break;
      for (const sec of pathSections(m)) {
        const dashes = layoutDashes(sec.endLen - sec.startLen, opts.dash, { closedLoop: sec.closedLoop, virtual: true });
        const spans: Interval[] = placement.at === "dashCentres" ? dashes : gapsOf(dashes);
        for (const [a, b] of spans) at(sec.startLen + (a + b) / 2);
      }
      break;
    }
    case "spaced": {
      const per = placement.perSpot ?? 1;
      const spacing = placement.spotSpacingUm ?? 0;
      for (const sec of pathSections(m, COORD_FLAG.corner)) {
        for (const spot of spacedInSection(sec, placement, closed)) {
          const first = spot - ((per - 1) * spacing) / 2;
          for (let i = 0; i < per; i++) {
            const l = first + i * spacing;
            if (l >= sec.startLen - 1e-6 && l <= sec.endLen + 1e-6) at(Math.max(0, Math.min(L, l)));
          }
        }
      }
      break;
    }
  }
  return out;
}
