/**
 * Uniform-grid index of polyline segments with a nearest-segment query.
 */

export interface NearestSegment {
  /** Distance from the query point. */
  d: number;
  /** Id the segment was added with. */
  id: number;
  /** Unit tangent of the segment. */
  tx: number;
  ty: number;
  /** Foot point on the segment. */
  fx: number;
  fy: number;
}

const KEY_OFFSET = 100000;
const KEY_STRIDE = 262144;

export class SegmentIndex {
  private readonly cells = new Map<number, number[]>();
  /** x1, y1, x2, y2, id per segment. */
  private readonly segs: number[] = [];

  constructor(private readonly cellMm: number) {}

  private key(cx: number, cy: number): number {
    return (cx + KEY_OFFSET) * KEY_STRIDE + (cy + KEY_OFFSET);
  }

  /** Adds the segments of a flat polyline (and its closing segment when `closed`). */
  addPolyline(p: ArrayLike<number>, id: number, closed = false): void {
    const n = p.length / 2;
    for (let i = 0; i < n - 1 + (closed ? 1 : 0); i++) {
      const j = (i + 1) % n;
      this.add(p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1], id);
    }
  }

  add(x1: number, y1: number, x2: number, y2: number, id: number): void {
    const si = this.segs.length / 5;
    this.segs.push(x1, y1, x2, y2, id);
    const c = this.cellMm;
    const ax = Math.floor(Math.min(x1, x2) / c), bx = Math.floor(Math.max(x1, x2) / c);
    const ay = Math.floor(Math.min(y1, y2) / c), by = Math.floor(Math.max(y1, y2) / c);
    for (let cx = ax; cx <= bx; cx++) {
      for (let cy = ay; cy <= by; cy++) {
        const k = this.key(cx, cy);
        const l = this.cells.get(k);
        if (l) l.push(si);
        else this.cells.set(k, [si]);
      }
    }
  }

  /**
   * The nearest segment strictly within `r` of (x, y); `onlyId` ≥ 0 keeps
   * one id, `notId` skips one. Ties keep the first segment found.
   */
  nearest(x: number, y: number, r: number, onlyId = -1, notId = -1): NearestSegment | null {
    const c = this.cellMm;
    const s = this.segs;
    let best = r, bi = -1, bfx = 0, bfy = 0;
    for (let cx = Math.floor((x - r) / c); cx <= Math.floor((x + r) / c); cx++) {
      for (let cy = Math.floor((y - r) / c); cy <= Math.floor((y + r) / c); cy++) {
        const l = this.cells.get(this.key(cx, cy));
        if (!l) continue;
        for (const si of l) {
          const o = si * 5, id = s[o + 4];
          if ((onlyId >= 0 && id !== onlyId) || id === notId) continue;
          const x1 = s[o], y1 = s[o + 1], dx = s[o + 2] - x1, dy = s[o + 3] - y1;
          const l2 = dx * dx + dy * dy;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / l2)) : 0;
          const fx = x1 + t * dx, fy = y1 + t * dy, d = Math.hypot(x - fx, y - fy);
          if (d < best) {
            best = d;
            bi = si;
            bfx = fx;
            bfy = fy;
          }
        }
      }
    }
    if (bi < 0) return null;
    const o = bi * 5, dx = s[o + 2] - s[o], dy = s[o + 3] - s[o + 1], l = Math.hypot(dx, dy) || 1;
    return { d: best, id: s[o + 4], tx: dx / l, ty: dy / l, fx: bfx, fy: bfy };
  }
}
