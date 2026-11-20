/**
 * A graphic's outline (J19; docs/map-rendering.md §4.11 "Knockout
 * footprints"): the silhouette of its opaque pixels, traced once from an
 * alpha raster, so a knockout image cuts the images below it where it is
 * drawn rather than over its whole box.
 *
 * Pure: the host decodes the graphic to an alpha raster (the API at
 * `OUTLINE_RASTER_PX` on the longer side) and stores the result
 * (`graphics.outline`). Pixels at or above `OUTLINE_ALPHA` are inside;
 * holes are filled (an opening in a drawn hatch is still the hatch's); at
 * most `OUTLINE_MAX_RINGS` outer rings are kept, the largest, each
 * simplified to at most `OUTLINE_MAX_VERTICES` vertices.
 */

/**
 * Outer rings, each a flat `[x0, y0, x1, y1, …]` in fractions of the whole
 * graphic (0…1, top-left origin, as `crop`). Empty: the silhouette is the
 * whole box (or nothing could be traced), so the box is the footprint.
 */
export type GraphicOutline = readonly (readonly number[])[];

/** The alpha raster's longer side the host traces at. */
export const OUTLINE_RASTER_PX = 512;
/** Alpha (0–255) at or above which a pixel is inside: 50 %. */
export const OUTLINE_ALPHA = 128;
export const OUTLINE_MAX_RINGS = 8;
export const OUTLINE_MAX_VERTICES = 200;
/** Inside covering this share of the raster or more is the whole box. */
const FULL_SHARE = 0.995;

/**
 * Trace `alpha` (`width × height`, row-major, one byte per pixel). Returns
 * `[]` for a silhouette that is (nearly) the whole box or empty.
 */
export function traceOutline(alpha: Uint8Array, width: number, height: number, threshold = OUTLINE_ALPHA): GraphicOutline {
  const w = width, h = height;
  if (!(w > 0) || !(h > 0) || alpha.length < w * h) return [];
  const inside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inside[i] = alpha[i] >= threshold ? 1 : 0;
  fillHoles(inside, w, h);
  let count = 0;
  for (let i = 0; i < w * h; i++) count += inside[i];
  if (count === 0 || count >= FULL_SHARE * w * h) return [];
  const rings = boundaryRings(inside, w, h)
    .map((r) => ({ r, area: Math.abs(ringArea(r)) }))
    .filter((x) => x.area > 0)
    .sort((a, b) => b.area - a.area)
    .slice(0, OUTLINE_MAX_RINGS)
    .map(({ r }) => simplifyRing(r, OUTLINE_MAX_VERTICES));
  const round = (v: number) => Math.round(v * 1e4) / 1e4;
  return rings.filter((r) => r.length >= 6).map((r) => r.map((v, i) => round(i % 2 === 0 ? v / w : v / h)));
}

/** Outside pixels not reachable from the border become inside (scanline-free BFS). */
function fillHoles(inside: Uint8Array, w: number, h: number): void {
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!inside[i] && !seen[i]) {
      seen[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w, y = (i - x) / w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  for (let i = 0; i < w * h; i++) if (!inside[i] && !seen[i]) inside[i] = 1;
}

/**
 * The boundary of the inside pixels as closed rings on the pixel-corner
 * grid (flat `[x, y, …]`, pixel units). Each boundary edge is directed with
 * the inside on its left, then edges are chained; at a corner where two
 * rings touch diagonally, the left turn is taken, so the rings never cross.
 */
function boundaryRings(inside: Uint8Array, w: number, h: number): number[][] {
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? inside[y * w + x] : 0);
  const W = w + 1;
  const key = (x: number, y: number) => y * W + x;
  // Outgoing edges per grid vertex: the end vertex, keyed by direction 0 → +x, 1 → +y, 2 → −x, 3 → −y.
  const out = new Map<number, number[]>();
  const add = (x0: number, y0: number, dir: number) => {
    const k = key(x0, y0);
    let list = out.get(k);
    if (!list) out.set(k, (list = []));
    list.push(dir);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside[y * w + x]) continue;
      // y down: walking with the inside on the left goes counter-clockwise on screen.
      if (!at(x, y - 1)) add(x + 1, y, 2); // top edge, right → left
      if (!at(x - 1, y)) add(x, y, 1); // left edge, top → bottom
      if (!at(x, y + 1)) add(x, y + 1, 0); // bottom edge, left → right
      if (!at(x + 1, y)) add(x + 1, y + 1, 3); // right edge, bottom → top
    }
  }
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  const rings: number[][] = [];
  for (const [start, dirs] of out) {
    while (dirs.length) {
      const sx = start % W, sy = (start - sx) / W;
      const ring: number[] = [];
      let x = sx, y = sy;
      let dir = dirs.pop()!;
      for (let guard = 0; guard < 4 * (w + 1) * (h + 1); guard++) {
        ring.push(x, y);
        x += DX[dir];
        y += DY[dir];
        if (x === sx && y === sy && !(out.get(start)?.length)) break;
        const next = out.get(key(x, y));
        if (!next || next.length === 0) break;
        // Prefer the left turn (inside on the left), then straight, then right.
        const order = [(dir + 3) % 4, dir, (dir + 1) % 4];
        const pick = order.find((d) => next.includes(d));
        if (pick === undefined) break;
        // Back at the start with an edge still there (a ring touching it diagonally): it continues this ring,
        // which then touches itself at one point — still one closed path for a fill.
        next.splice(next.indexOf(pick), 1);
        dir = pick;
      }
      rings.push(dropCollinear(ring));
    }
  }
  return rings;
}

/** A closed ring without its collinear (straight-through) vertices. */
function dropCollinear(r: number[]): number[] {
  const n = r.length / 2;
  if (n < 4) return r;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n, c = (i + 1) % n;
    const cross = (r[2 * i] - r[2 * a]) * (r[2 * c + 1] - r[2 * i + 1]) - (r[2 * i + 1] - r[2 * a + 1]) * (r[2 * c] - r[2 * i]);
    if (cross !== 0) out.push(r[2 * i], r[2 * i + 1]);
  }
  return out;
}

function ringArea(r: readonly number[]): number {
  let a = 0;
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += r[2 * i] * r[2 * j + 1] - r[2 * j] * r[2 * i + 1];
  }
  return a / 2;
}

/** Douglas–Peucker on a closed ring, the tolerance grown from 0.75 px until it has at most `max` vertices. */
function simplifyRing(r: readonly number[], max: number): number[] {
  let tol = 0.75;
  let out = dp(r, tol);
  while (out.length / 2 > max) {
    tol *= 1.5;
    out = dp(r, tol);
  }
  return out;
}

function dp(r: readonly number[], tol: number): number[] {
  const n = r.length / 2;
  if (n <= 4) return [...r];
  // Split the closed ring at its first vertex and the vertex farthest from it.
  let far = 0, best = -1;
  for (let i = 1; i < n; i++) {
    const d = (r[2 * i] - r[0]) ** 2 + (r[2 * i + 1] - r[1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const pts = (from: number, to: number) => {
    const list: number[] = [];
    for (let i = from; ; i = (i + 1) % n) {
      list.push(i);
      if (i === to) break;
    }
    return list;
  };
  const keep = new Uint8Array(n);
  const run = (idx: number[]) => {
    const stack: [number, number][] = [[0, idx.length - 1]];
    keep[idx[0]] = keep[idx[idx.length - 1]] = 1;
    while (stack.length) {
      const [a, b] = stack.pop()!;
      const ax = r[2 * idx[a]], ay = r[2 * idx[a] + 1], bx = r[2 * idx[b]], by = r[2 * idx[b] + 1];
      const len = Math.hypot(bx - ax, by - ay) || 1;
      let worst = -1, wd = tol;
      for (let k = a + 1; k < b; k++) {
        const px = r[2 * idx[k]], py = r[2 * idx[k] + 1];
        const d = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
        if (d > wd) { wd = d; worst = k; }
      }
      if (worst >= 0) {
        keep[idx[worst]] = 1;
        stack.push([a, worst], [worst, b]);
      }
    }
  };
  run(pts(0, far));
  run(pts(far, 0));
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(r[2 * i], r[2 * i + 1]);
  return out;
}
