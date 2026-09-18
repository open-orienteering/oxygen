export interface OverlayPoint {
  x: number;
  y: number;
}

export interface OverlaySegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface FractionGap {
  from: number;
  to: number;
}

export interface AngularGap {
  start: number;
  end: number;
}

/** Clip a line segment around every circular obstacle. */
export function clipLine(
  a: OverlayPoint,
  b: OverlayPoint,
  obstacles: OverlayPoint[],
  clearance: number,
): OverlaySegment[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return [];
  const ux = dx / length;
  const uy = dy / length;

  const blocks: Array<[number, number]> = [];
  for (const obstacle of obstacles) {
    const vx = obstacle.x - a.x;
    const vy = obstacle.y - a.y;
    const along = vx * ux + vy * uy;
    const px = a.x + along * ux - obstacle.x;
    const py = a.y + along * uy - obstacle.y;
    const perpendicular = Math.hypot(px, py);
    if (perpendicular < clearance) {
      const half = Math.sqrt(clearance * clearance - perpendicular * perpendicular);
      blocks.push([along - half, along + half]);
    }
  }

  blocks.sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const block of blocks) {
    const last = merged.at(-1);
    if (last && block[0] <= last[1]) {
      last[1] = Math.max(last[1], block[1]);
    } else {
      merged.push([...block]);
    }
  }

  const segments: OverlaySegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    const visibleStart = Math.max(cursor, 0);
    const visibleEnd = Math.min(start, length);
    if (visibleEnd - visibleStart > 1) {
      segments.push({
        x1: a.x + visibleStart * ux,
        y1: a.y + visibleStart * uy,
        x2: a.x + visibleEnd * ux,
        y2: a.y + visibleEnd * uy,
      });
    }
    cursor = end;
  }
  const visibleStart = Math.max(cursor, 0);
  if (length - visibleStart > 1) {
    segments.push({
      x1: a.x + visibleStart * ux,
      y1: a.y + visibleStart * uy,
      x2: a.x + length * ux,
      y2: a.y + length * uy,
    });
  }
  return segments;
}

/** Remove fractional gaps from a polyline while preserving bend points. */
export function subtractLegGaps(
  points: OverlayPoint[],
  gaps: FractionGap[],
): OverlayPoint[][] {
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(
      cumulative[index - 1] +
        Math.hypot(
          points[index].x - points[index - 1].x,
          points[index].y - points[index - 1].y,
        ),
    );
  }
  const total = cumulative.at(-1) ?? 0;
  if (total === 0) return [points];

  const sorted = gaps
    .map((gap): [number, number] => [
      Math.max(0, gap.from),
      Math.min(1, gap.to),
    ])
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0]);
  const kept: Array<[number, number]> = [];
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (start > cursor) kept.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < 1) kept.push([cursor, 1]);

  const pointAt = (fraction: number): OverlayPoint => {
    const distance = fraction * total;
    let index = 1;
    while (
      index < cumulative.length - 1 &&
      cumulative[index] < distance
    ) {
      index += 1;
    }
    const segmentLength = cumulative[index] - cumulative[index - 1] || 1;
    const local = (distance - cumulative[index - 1]) / segmentLength;
    return {
      x: points[index - 1].x + local * (points[index].x - points[index - 1].x),
      y: points[index - 1].y + local * (points[index].y - points[index - 1].y),
    };
  };

  return kept.map(([start, end]) => {
    const result = [pointAt(start)];
    for (let index = 0; index < points.length; index += 1) {
      const fraction = cumulative[index] / total;
      if (fraction > start && fraction < end) result.push(points[index]);
    }
    result.push(pointAt(end));
    return result;
  });
}

/** Build the SVG path for a control circle with angular slit gaps. */
export function drawBrokenCircle(
  cx: number,
  cy: number,
  radius: number,
  gaps: AngularGap[],
): string {
  const normalized = gaps
    .map((gap) => ({
      start: ((gap.start % 360) + 360) % 360,
      end: ((gap.end % 360) + 360) % 360,
    }))
    .filter((gap) => Math.abs(gap.start - gap.end) >= 0.5);
  if (normalized.length === 0) {
    return `M${cx + radius},${cy} A${radius},${radius} 0 1 1 ${cx - radius},${cy} A${radius},${radius} 0 1 1 ${cx + radius},${cy}`;
  }

  const gapAngles: Array<[number, number]> = [];
  for (const gap of normalized) {
    if (gap.start < gap.end) gapAngles.push([gap.start, gap.end]);
    else gapAngles.push([gap.start, 360], [0, gap.end]);
  }
  gapAngles.sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const gap of gapAngles) {
    const last = merged.at(-1);
    if (last && gap[0] <= last[1]) last[1] = Math.max(last[1], gap[1]);
    else merged.push([...gap]);
  }

  const arcs: Array<[number, number]> = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) arcs.push([cursor, start]);
    cursor = end;
  }
  if (cursor < 360) arcs.push([cursor, 360]);

  return arcs
    .filter(([start, end]) => end - start >= 0.5)
    .map(([start, end]) => {
      const startRad = ((90 - start) * Math.PI) / 180;
      const endRad = ((90 - end) * Math.PI) / 180;
      const x1 = cx + radius * Math.cos(startRad);
      const y1 = cy - radius * Math.sin(startRad);
      const x2 = cx + radius * Math.cos(endRad);
      const y2 = cy - radius * Math.sin(endRad);
      return `M${x1.toFixed(1)},${y1.toFixed(1)} A${radius},${radius} 0 ${end - start > 180 ? 1 : 0} 1 ${x2.toFixed(1)},${y2.toFixed(1)}`;
    })
    .join(" ");
}
