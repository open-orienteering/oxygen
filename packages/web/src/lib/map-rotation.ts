/**
 * Geometry helpers for the rotated map viewer.
 *
 * When the map is rotated by `deg` degrees inside an outer container of
 * size `outerW × outerH`, the inner (rotated) layer must be sized so that
 * after rotation it still fully covers the outer rectangle — otherwise the
 * unrotated corners of the outer container show through as blank wedges.
 *
 * The minimum bounding box of an inner W×H rectangle that covers an outer
 * `outerW × outerH` rectangle when rotated by θ around their shared centre
 * is:
 *
 *   innerW = outerW · |cos θ| + outerH · |sin θ|
 *   innerH = outerW · |sin θ| + outerH · |cos θ|
 *
 * The previous `(|cos θ| + |sin θ|)` single-factor scaling is only correct
 * when the container is square; for landscape/portrait viewports it
 * under-covers the short axis and produces visible wedges in the corners.
 */
export function rotatedBoundingBox(
  outerW: number,
  outerH: number,
  deg: number,
): { width: number; height: number } {
  if (deg === 0) return { width: outerW, height: outerH };
  const rad = (deg * Math.PI) / 180;
  const absCos = Math.abs(Math.cos(rad));
  const absSin = Math.abs(Math.sin(rad));
  // Math.ceil so we always over-cover by ≤1px instead of under-covering due
  // to float rounding.
  return {
    width: Math.ceil(outerW * absCos + outerH * absSin),
    height: Math.ceil(outerW * absSin + outerH * absCos),
  };
}
