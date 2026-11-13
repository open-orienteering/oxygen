/**
 * Field mode's pure parts (docs/course-editor.md §9, §10; 08 §5.5): the GPS
 * fix on paper through `mapGeo` (never a second coordinate system, 04 §7),
 * distance and bearing from it, the nudge pad's steps, the bottom sheet's
 * detents and the editor's initial mode.
 */

import type { mapGeo } from "@oxygen/shared";
import type { GeolocationFix } from "../../hooks/useGeolocationWatch";
import { geoToMm } from "../map-viewport";
import type { EditorMode } from "./state";

type Pt = { x: number; y: number };

/** A fix on paper: mm, y-up, and its accuracy radius in paper mm. */
export interface PaperFix extends Pt {
  accuracyMm: number;
}

/** WGS 84 → paper mm through the document's frame; null without a CRS. */
export function fixToPaper(frame: mapGeo.PaperFrame | null, fix: GeolocationFix): PaperFix | null {
  const p = geoToMm(frame, fix.lat, fix.lng);
  if (!p || !frame) return null;
  return { x: p.x, y: p.y, accuracyMm: (fix.accuracy * 1000) / frame.mapScale };
}

/** Metres on the ground between two paper points at 1:`mapScale`, rounded to the metre. */
export function distanceM(a: Pt, b: Pt, mapScale: number): number {
  return Math.round((Math.hypot(b.x - a.x, b.y - a.y) * mapScale) / 1000);
}

/** Degrees clockwise from paper north (the map's north lines, what the compass reads), 0–359. */
export function bearingDeg(from: Pt, to: Pt): number {
  const deg = Math.round((Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI);
  return ((deg % 360) + 360) % 360;
}

export interface FieldRowInput {
  id: number;
  code: string;
  kind: "control" | "start" | "finish";
  pt: Pt | null;
}

export interface FieldRow extends FieldRowInput {
  distanceM: number | null;
  bearingDeg: number | null;
  checked: boolean;
}

/** The control list (§9): course order, distance and bearing from the fix (blank without one or without a position). */
export function fieldRows(rows: readonly FieldRowInput[], fix: Pt | null, mapScale: number | null, checked: ReadonlySet<number>): FieldRow[] {
  return rows.map((r) => {
    const far = fix && r.pt && mapScale ? { distanceM: distanceM(fix, r.pt, mapScale), bearingDeg: bearingDeg(fix, r.pt) } : { distanceM: null, bearingDeg: null };
    return { ...r, ...far, checked: checked.has(r.id) };
  });
}

// ─── Nudge pad (§9 "Precision") ──────────────────────────────

export type NudgeDir = "up" | "down" | "left" | "right";

/** The fine step: a tenth of a paper millimetre. */
export const NUDGE_FINE_MM = 0.1;

/** One metre on the ground in paper mm. */
export const metreStepMm = (mapScale: number): number => 1000 / mapScale;

/** `pt` moved by `stepMm` along the paper axes (y up), rounded to µm. */
export function nudge(pt: Pt, dir: NudgeDir, stepMm: number): Pt {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  switch (dir) {
    case "up": return { x: pt.x, y: r(pt.y + stepMm) };
    case "down": return { x: pt.x, y: r(pt.y - stepMm) };
    case "left": return { x: r(pt.x - stepMm), y: pt.y };
    case "right": return { x: r(pt.x + stepMm), y: pt.y };
  }
}

// ─── Bottom sheet (§10) ──────────────────────────────────────

export type Detent = "peek" | "half" | "full";
export type DetentHeights = Record<Detent, number>;

/** Peek: the handle, the KPI line and one row of ≥ 44 px targets. */
export const PEEK_PX = 120;
/** Full leaves the top bar's height of map above the sheet. */
const FULL_GAP_PX = 56;

/** The sheet's heights in a panel `panelPx` tall; always peek ≤ half ≤ full. */
export function detentHeights(panelPx: number): DetentHeights {
  const full = Math.max(0, panelPx - FULL_GAP_PX);
  const peek = Math.min(PEEK_PX, full);
  const half = Math.min(full, Math.max(peek, Math.round(panelPx * 0.45)));
  return { peek, half, full };
}

/** Where a released drag of the handle settles: the nearest detent. */
export function nearestDetent(px: number, h: DetentHeights): Detent {
  const order: Detent[] = ["peek", "half", "full"];
  return order.reduce((best, d) => (Math.abs(h[d] - px) < Math.abs(h[best] - px) ? d : best), "peek");
}

/** Where a centred point should sit relative to the view centre so it lands mid-way in the band above a sheet `sheetPx` tall. */
export function bandCentreOffsetPx(sheetPx: number): Pt {
  return { x: 0, y: sheetPx > 0 ? -sheetPx / 2 : 0 };
}

/** The editor opens in Field mode on a phone (< 640 px), in Course mode otherwise (08 §5.5). */
/** The mode the editor opens in: the URL's (F31, docs/course-editor.md §1 "URL") — but Layout is not a phone mode — else the device's. */
export const initialModeFor = (o: { phone: boolean; url?: EditorMode | null }): EditorMode =>
  o.url && !(o.phone && o.url === "layout") ? o.url : o.phone ? "field" : "course";
