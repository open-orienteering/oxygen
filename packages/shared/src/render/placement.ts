/**
 * Glyph placement along lines (03 §6.9 item 3): where along the path a
 * line symbol's glyphs sit and at what angle. Output is a list of
 * `(lengthAlongPath, angleDeg, scale)`; the caller turns them into
 * instance transforms.
 */

import { COORD_FLAG } from "./pass-stream.js";
import { type DashGrid, dashGrid, gridCentre, gridGaps } from "./dash.js";
import { type PathMeasure, type Section, pathSections, wrapLength } from "./measure.js";
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

/** The virtual dash grid of a section (laid out even on a solid line, so zero gaps still place glyphs). */
function sectionGrid(sec: Section, dash: DashPattern): DashGrid {
  return dashGrid(sec.endLen - sec.startLen, dash, { closedLoop: sec.closedLoop, virtual: true, halfStart: sec.dashStart, halfEnd: sec.dashEnd });
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
        const g = sectionGrid(sec, opts.dash);
        const spans = placement.at === "dashCentres" ? g.dashes.map((d): [number, number] => [d.a, d.b]) : gridGaps(g);
        for (const [a, b] of spans) {
          const c = gridCentre(g, (a + b) / 2);
          if (c !== undefined) at(wrapLength(sec.startLen + c, L));
        }
      }
      break;
    }
    case "dashGroupCentres": {
      // The dash grid before the secondary split; a glyph in every dash
      // that the split cuts (OCAD puts the main symbol in the secondary
      // gap), or in every dash when nothing is cut.
      if (!opts.dash) break;
      const whole: DashPattern = { ...opts.dash, secondaryGapUm: undefined, endGapUm: undefined };
      const cutsInterior = (opts.dash.secondaryGapUm ?? 0) > 0;
      const cutsEnds = (opts.dash.endGapUm ?? 0) > 0;
      for (const sec of pathSections(m)) {
        const g = sectionGrid(sec, whole);
        for (const d of g.dashes) {
          const cut = d.end ? cutsEnds : cutsInterior;
          const c = gridCentre(g, (d.a + d.b) / 2);
          if (c !== undefined && (cut || (!cutsInterior && !cutsEnds))) at(wrapLength(sec.startLen + c, L));
        }
      }
      break;
    }
    case "sectionCentres": {
      for (const sec of pathSections(m)) at(wrapLength((sec.startLen + sec.endLen) / 2, L));
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
            if (l >= sec.startLen - 1e-6 && l <= sec.endLen + 1e-6) at(Math.max(0, Math.min(L, wrapLength(l, L))));
          }
        }
      }
      break;
    }
  }
  return out;
}
