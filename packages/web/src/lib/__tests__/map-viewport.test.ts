import { describe, it, expect } from "vitest";
import type { mapGeo } from "@oxygen/shared";
import { rotatedBoundingBox } from "../map-rotation";
import { project, viewMatrix } from "../../map-gl/view";
import {
  centreOnGeo,
  centreShiftPx,
  fitMm,
  geoToInner,
  geoToMm,
  glView,
  innerToGeo,
  innerToMm,
  mercatorEquivalentZoom,
  metresPerPx,
  mmToGeo,
  mmToInner,
  panBy,
  PAPER_MAX_PX_PER_MM,
  pxPerMapMm,
  viewportRotationDeg,
  zoomAt,
  type PaperViewport,
  type ViewportContext,
} from "../map-viewport";

/** A SWEREF 99 TM frame like an OCAD file's: 100 units/mm, 1:10 000, 2° grivation. */
const FRAME: mapGeo.PaperFrame = {
  unitsPerMm: 100,
  mapScale: 10000,
  georeferencing: {
    crs: { authority: "EPSG", code: 3006, name: "SWEREF99 TM" },
    paperOrigin: { x: 674000, y: 6580000 },
    gridRotationDeg: 2,
    gridScaleFactor: 1,
  },
};

const paper = (centreX: number, centreY: number, pxPerMm: number): PaperViewport => ({
  centreX, centreY, pxPerUm: pxPerMm / 1000,
});

const ctx = (w: number, h: number, frame: mapGeo.PaperFrame | null = FRAME): ViewportContext => ({ w, h, frame });

/** Web Mercator ground metres per CSS px at a zoom (the slippy-map formula `data-zoom` is defined by). */
const mercatorMetresPerPx = (lat: number, zoom: number) =>
  (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** zoom);

describe("paper view", () => {
  const vp = paper(150_000, 80_000, 4);
  const c = ctx(800, 600);

  it("puts the centre in the middle of the frame, y-up on paper → y-down on screen", () => {
    expect(mmToInner(vp, c, 150, 80)).toEqual({ x: 400, y: 300 });
    const p = mmToInner(vp, c, 151, 81)!;
    expect(p.x).toBeCloseTo(404, 9);
    expect(p.y).toBeCloseTo(296, 9);
  });

  it("round-trips mm ↔ inner", () => {
    const p = mmToInner(vp, c, 123.456, 78.9)!;
    const back = innerToMm(vp, c, p.x, p.y)!;
    expect(back.x).toBeCloseTo(123.456, 9);
    expect(back.y).toBeCloseTo(78.9, 9);
  });

  it("goes to WGS 84 through mapGeo only, round trip within 1e-6 mm", () => {
    const g = mmToGeo(FRAME, 120, 75)!;
    const mm = geoToMm(FRAME, g.lat, g.lng)!;
    expect(mm.x).toBeCloseTo(120, 6);
    expect(mm.y).toBeCloseTo(75, 6);
    const inner = geoToInner(vp, c, g.lat, g.lng)!;
    const direct = mmToInner(vp, c, 120, 75)!;
    expect(inner.x).toBeCloseTo(direct.x, 4);
    expect(inner.y).toBeCloseTo(direct.y, 4);
    const back = innerToGeo(vp, c, inner.x, inner.y)!;
    expect(back.lat).toBeCloseTo(g.lat, 9);
    expect(back.lng).toBeCloseTo(g.lng, 9);
  });

  it("has no geo mapping without a CRS (the document still draws)", () => {
    const nc = ctx(800, 600, null);
    expect(geoToInner(vp, nc, 59.3, 18.1)).toBeNull();
    expect(innerToGeo(vp, nc, 1, 1)).toBeNull();
    expect(centreOnGeo(vp, nc, 59.3, 18.1)).toBe(vp);
    expect(mmToInner(vp, nc, 150, 80)).toEqual({ x: 400, y: 300 });
  });

  it("wheel zoom keeps the anchor; pinch moves it to the target", () => {
    const anchorMm = innerToMm(vp, c, 250, 100)!;
    const z = zoomAt(vp, c, 250, 100, 0.15);
    const p = mmToInner(z, c, anchorMm.x, anchorMm.y)!;
    expect(p.x).toBeCloseTo(250, 9);
    expect(p.y).toBeCloseTo(100, 9);
    expect(z.pxPerUm).toBeCloseTo(vp.pxPerUm * 2 ** 0.15, 12);

    const pinch = zoomAt(vp, c, 250, 100, Math.log2(1.5), 300, 140);
    const q = mmToInner(pinch, c, anchorMm.x, anchorMm.y)!;
    expect(q.x).toBeCloseTo(300, 9);
    expect(q.y).toBeCloseTo(140, 9);
  });

  it("clamps zoom", () => {
    const z = zoomAt(vp, c, 400, 300, 40);
    expect(z.pxPerUm).toBe(PAPER_MAX_PX_PER_MM / 1000);
  });

  it("pans so content follows the pointer", () => {
    const before = mmToInner(vp, c, 140, 70)!;
    const after = mmToInner(panBy(vp, 30, -20), c, 140, 70)!;
    expect(after.x - before.x).toBeCloseTo(30, 9);
    expect(after.y - before.y).toBeCloseTo(-20, 9);
    expect(centreShiftPx(vp, panBy(vp, 30, -40))).toBeCloseTo(50, 9);
  });

  it("centres on a GPS fix", () => {
    const g = mmToGeo(FRAME, 100, 50)!;
    const v = centreOnGeo(vp, c, g.lat, g.lng);
    const p = geoToInner(v, c, g.lat, g.lng)!;
    expect(p.x).toBeCloseTo(400, 4);
    expect(p.y).toBeCloseTo(300, 4);
  });

  it("fits mm bounds with padding", () => {
    const f = fitMm({ minX: 0, minY: 0, maxX: 400, maxY: 200 }, 800, 600, 0.05);
    expect(f.centreX).toBe(200_000);
    expect(f.centreY).toBe(100_000);
    // Width-limited: 720 px for 400 mm.
    expect(f.pxPerUm).toBeCloseTo(720 / 400_000, 12);
    const tl = mmToInner(f, c, 0, 200)!;
    expect(tl.x).toBeCloseTo(40, 9);
  });

  it("scale: px per mm, metres per px, Mercator-equivalent zoom", () => {
    expect(pxPerMapMm(vp)).toBeCloseTo(4, 12);
    // 1:10 000 at 4 px/mm → 2.5 m per px.
    expect(metresPerPx(vp, 10000)).toBeCloseTo(2.5, 12);
    expect(metresPerPx(vp, null)).toBeNull();
    const z = mercatorEquivalentZoom(vp, 10000, 59.3)!;
    expect(mercatorMetresPerPx(59.3, z)).toBeCloseTo(2.5, 9);
    expect(mercatorEquivalentZoom(vp, 10000, null)).toBeNull();
  });
});

describe("rotation", () => {
  it("rotates by the meridian tilt only (northOffset − cutRotationDeg)", () => {
    expect(viewportRotationDeg(12, 9, 0)).toBe(-3);
    expect(viewportRotationDeg(12, 9, 5)).toBe(2);
    expect(viewportRotationDeg(null, null, 0)).toBe(0);
    expect(viewportRotationDeg(12, null, 0)).toBe(0);
  });

  it("puts a +3° tilted paper meridian vertical on screen, overlay and GL alike", () => {
    const vp = paper(100_000, 100_000, 3);
    const rot = viewportRotationDeg(10, 7, 0);
    const t = (3 * Math.PI) / 180;
    // Two points on a line tilted 3° clockwise from paper +Y.
    const a = { x: 100, y: 100 }, b = { x: 100 + 50 * Math.sin(t), y: 100 + 50 * Math.cos(t) };
    const m = viewMatrix(glView(vp, 640, 480, 1, rot), 0, 0);
    const pa = project(m, a.x * 1000, a.y * 1000), pb = project(m, b.x * 1000, b.y * 1000);
    expect(pb[0] - pa[0]).toBeCloseTo(0, 9);
    expect(pb[1]).toBeGreaterThan(pa[1]);
    // The overlay: inner frame point rotated by CSS rotate(rot) about the centre.
    const sa = toContainer(vp, a, 640, 480, rot), sb = toContainer(vp, b, 640, 480, rot);
    expect(sb.x - sa.x).toBeCloseTo(0, 9);
    expect(sb.y).toBeLessThan(sa.y);
  });
});

/** Container CSS px of a paper-mm point via the overlay path (inner frame + CSS rotation). */
function toContainer(vp: PaperViewport, mm: { x: number; y: number }, cw: number, ch: number, rotDeg: number) {
  const { width: w, height: h } = rotatedBoundingBox(cw, ch, rotDeg);
  const p = mmToInner(vp, { w, h, frame: null }, mm.x, mm.y)!;
  const r = (rotDeg * Math.PI) / 180;
  const dx = p.x - w / 2, dy = p.y - h / 2;
  return { x: cw / 2 + dx * Math.cos(r) - dy * Math.sin(r), y: ch / 2 + dx * Math.sin(r) + dy * Math.cos(r) };
}

describe("overlay and GL canvas agree", () => {
  it("to < 0.5 CSS px at any point, rotation and DPR included", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 200; i++) {
      const cw = 300 + Math.round(rnd() * 900), ch = 300 + Math.round(rnd() * 700);
      const dpr = [1, 1.5, 2, 2.625, 3][i % 5];
      const rot = i % 3 === 0 ? 0 : (rnd() - 0.5) * 360;
      const vp = paper(rnd() * 1e6, rnd() * 1e6, 0.1 + rnd() * 50);
      const view = glView(vp, cw, ch, dpr, rot);
      const m = viewMatrix(view, 0, 0);
      // A point that is on screen: inside the container.
      const ix = rnd() * cw, iy = rnd() * ch;
      const { width: w, height: h } = rotatedBoundingBox(cw, ch, rot);
      // Container → inner, then inner → mm via the model.
      const r = (-rot * Math.PI) / 180;
      const dx = ix - cw / 2, dy = iy - ch / 2;
      const inner = { x: w / 2 + dx * Math.cos(r) - dy * Math.sin(r), y: h / 2 + dx * Math.sin(r) + dy * Math.cos(r) };
      const mm = innerToMm(vp, { w, h, frame: null }, inner.x, inner.y)!;
      const overlay = toContainer(vp, mm, cw, ch, rot);
      const [clipX, clipY] = project(m, mm.x * 1000, mm.y * 1000);
      const glX = ((clipX + 1) / 2) * view.widthPx / dpr;
      const glY = ((1 - clipY) / 2) * view.heightPx / dpr;
      expect(Math.abs(glX - overlay.x)).toBeLessThan(0.5);
      expect(Math.abs(glY - overlay.y)).toBeLessThan(0.5);
    }
  });
});
