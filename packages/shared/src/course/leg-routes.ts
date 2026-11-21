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
    return { points: routePolyline(leg.points[0], route, leg.points[leg.points.length - 1]), routed: true };
  });
}

/** The length of a polyline in paper mm. */
export function routeLengthMm(points: readonly RoutePoint[]): number {
  let mm = 0;
  for (let i = 1; i < points.length; i++) mm += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return mm;
}
