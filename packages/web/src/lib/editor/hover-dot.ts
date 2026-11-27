/**
 * A place on the map another panel points at (docs/course-elevation.md §5:
 * the profile graph's pointer). A store the viewer's leaf subscribes to,
 * so a moving pointer redraws one dot and not the page.
 */

export interface HoverDot {
  /** Paper mm. */
  x: number;
  y: number;
  /** The leg the place lies on. */
  leg: number;
}

export interface HoverDotStore {
  get: () => HoverDot | null;
  set: (dot: HoverDot | null) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createHoverDotStore(): HoverDotStore {
  let dot: HoverDot | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => dot,
    set: (next) => {
      if (next === dot || (next && dot && next.x === dot.x && next.y === dot.y && next.leg === dot.leg)) return;
      dot = next;
      for (const l of listeners) l();
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
  };
}
