/**
 * Leg routes (docs/course-elevation.md §7): a route is a polyline between
 * two controls of an event, in the direction it is run, stored once per
 * directed pair and shared by every course that runs that pair. A leg
 * whose pair has a **chosen** route is profiled along the route; its
 * drawn line, its length and its print are unchanged.
 */

import { z } from "zod";

export interface RoutePoint { x: number; y: number }

/** A route's interior vertices, paper mm: the ends are the controls' own centres and follow them. */
export const LEG_ROUTE_MAX_POINTS = 2000;
export const legRoutePointsSchema = z.array(z.object({ x: z.number().finite(), y: z.number().finite() }).strict()).min(1).max(LEG_ROUTE_MAX_POINTS);

/** The expected winner pace of a course, seconds per km: 2:00 to 30:00 (§7.8). */
export const WINNER_PACE_MIN_S = 120;
export const WINNER_PACE_MAX_S = 1800;

export const LEG_ROUTE_SOURCES = ["drawn", "computed"] as const;
export type LegRouteSource = (typeof LEG_ROUTE_SOURCES)[number];

/** The key of a directed pair, as the canvas keys a leg: `"<from>><to>"`. */
export const legPairKey = (from: string | number, to: string | number): string => `${from}>${to}`;

/** The route's whole polyline between two centres. */
export function routePolyline(from: RoutePoint, interior: readonly RoutePoint[], to: RoutePoint): RoutePoint[] {
  return [{ x: from.x, y: from.y }, ...interior.map((p) => ({ x: p.x, y: p.y })), { x: to.x, y: to.y }];
}

export interface RoutableLeg {
  from: string;
  to: string;
  points: readonly RoutePoint[];
  /** A `marked_route` leg is its own route (§7.3). */
  style?: string;
  /** Half the leg's corridor width, paper mm, when it has one: a route that leaves the corridor is not read (§7.3). */
  corridorHalfMm?: number | null;
}

export interface RoutedLeg {
  points: readonly RoutePoint[];
  /** The leg is read along its pair's chosen route. */
  routed: boolean;
}

/**
 * The polylines a course's climb and profile are read along (§7.3): each
 * leg's chosen route from the leg's first point to its last, else the
 * leg's drawn line. `chosen` maps `legPairKey(from, to)` to the chosen
 * route's interior vertices.
 */
export function routedLegs(legs: readonly RoutableLeg[], chosen: ReadonlyMap<string, readonly RoutePoint[]> | null | undefined): RoutedLeg[] {
  return legs.map((leg) => {
    const route = leg.style === "marked_route" || leg.points.length < 2 ? undefined : chosen?.get(legPairKey(leg.from, leg.to));
    if (!route || route.length === 0) return { points: leg.points, routed: false };
    const points = routePolyline(leg.points[0], route, leg.points[leg.points.length - 1]);
    if (leg.corridorHalfMm && !routeInsideCorridor(leg.points, points, leg.corridorHalfMm)) return { points: leg.points, routed: false };
    return { points, routed: true };
  });
}

/** How far past a corridor's edge a route may pass and still be inside, paper mm: the search's cells straddle the edge. */
export const CORRIDOR_EDGE_TOLERANCE_MM = 0.3;

function distanceToPolyline(p: RoutePoint, line: readonly RoutePoint[]): number {
  if (line.length === 1) return Math.hypot(p.x - line[0].x, p.y - line[0].y);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

/**
 * Does a route stay inside a leg's corridor (§7.3): every point of it,
 * sampled every 0.1 mm, within `halfMm` of the leg's line (its centre),
 * give or take `CORRIDOR_EDGE_TOLERANCE_MM`.
 */
export function routeInsideCorridor(line: readonly RoutePoint[], route: readonly RoutePoint[], halfMm: number): boolean {
  if (line.length === 0) return true;
  const reach = halfMm + CORRIDOR_EDGE_TOLERANCE_MM;
  for (let i = 0; i < route.length; i++) {
    const a = route[i], b = route[Math.min(i + 1, route.length - 1)];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.1));
    for (let s = 0; s <= steps; s++) {
      if (distanceToPolyline({ x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps }, line) > reach) return false;
    }
  }
  return true;
}

/** The length of a polyline in paper mm. */
export function routeLengthMm(points: readonly RoutePoint[]): number {
  let mm = 0;
  for (let i = 1; i < points.length; i++) mm += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return mm;
}
