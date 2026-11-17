/**
 * *Corrections* → *Not carried over* (docs/course-editor.md §13 "Unresolved"; docs/map-patches.md §4): the rules for
 * the patch's `unresolved` entries — their rows, where a row click centres the view, and what *Attach* needs. Pure.
 */

import type { mapDocument } from "@oxygen/shared";
import { kindOfType } from "./symbols";

type Pt = { x: number; y: number };

/**
 * What *Attach* takes for an entry (§13; map-patches §4.3): `object` — a `target` entry of a hide, modify or resymbol
 * goes onto the document object selected on the map; `symbol` — a `symbol` entry (a resymbol whose symbol is gone, an
 * add) takes a symbol picked in the palette (G12b; user 2026-11-15, G9 question 1).
 */
export type AttachKind = "object" | "symbol";

export function attachKind(e: mapDocument.UnresolvedOp): AttachKind {
  return e.reason === "target" && e.op.op !== "add" ? "object" : "symbol";
}

/** The palette's kind for a `symbol` entry: an add's own type, a resymbol's object's (its anchor); null otherwise. */
export function entryPickerKind(e: mapDocument.UnresolvedOp): "point" | "line" | "area" | null {
  if (attachKind(e) !== "symbol") return null;
  if (e.op.op === "add") return kindOfType(e.op.type);
  return e.target ? kindOfType(e.target.type) : null;
}

/**
 * Where the entry's object was, paper mm (the row click's locate, §13 "Unresolved"): the target anchor's box centre,
 * an add's own box centre (its coordinates in the entry's unit); null without either. Editions share paper
 * coordinates (map-patches §4.2 step 3), so the place is the same on the pinned document.
 */
export function entryCentre(e: mapDocument.UnresolvedOp): Pt | null {
  if (e.target) return { x: e.target.centreMm[0], y: e.target.centreMm[1] };
  if (e.op.op !== "add" || e.op.coords.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of e.op.coords) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: (minX + maxX) / 2 / e.unitsPerMm, y: (minY + maxY) / 2 / e.unitsPerMm };
}

/** The symbol an entry was on, as the row names it: the target's, else the op's `{ doc }` symbol, else the patch symbol key. */
export function entryLabel(e: mapDocument.UnresolvedOp): string {
  const s = e.target?.symbol ?? e.symbol;
  if (s) return `${s.code} ${s.name}`.trim();
  return "symbol" in e.op && "patch" in e.op.symbol ? e.op.symbol.patch : "";
}

export interface UnresolvedRow {
  key: string;
  entry: mapDocument.UnresolvedOp;
  label: string;
  attach: AttachKind;
  /** Null: no place to centre on. */
  centre: Pt | null;
}

/** The patch's entries in key order (§13 "Unresolved"). */
export function unresolvedRows(patch: mapDocument.MapPatch | null): UnresolvedRow[] {
  const u = patch?.unresolved;
  if (!u) return [];
  return Object.keys(u).sort().map((key) => ({ key, entry: u[key], label: entryLabel(u[key]), attach: attachKind(u[key]), centre: entryCentre(u[key]) }));
}
