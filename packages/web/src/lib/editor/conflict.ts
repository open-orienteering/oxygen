/**
 * The new editor's client rules for a version `CONFLICT`
 * (docs/course-layer.md §7 "Client rules"; docs/course-editor.md §3):
 *
 * - **Field move** on a stale control: re-sent with the fresh token when
 *   the other side changed only fields a move does not touch
 *   (description, code, notes, kind, circle gaps, checked, …); when the
 *   other side moved it too, the user keeps one of the two positions.
 * - **Other control writes** (a description, a code): the same rebase on
 *   disjoint fields, otherwise refresh and let the user redo.
 * - **Structure edit** on a stale structure: never merged — refresh, show
 *   the differing items, the user redoes the edit.
 *
 * Pure: the write client (`write-client.ts`) acts on the decision.
 */

import type { VersionConflictData } from "@oxygen/shared";

type Pt = { x: number; y: number };

/** The control fields a move writes (`control.update { xpos, ypos }`). */
export const MOVE_FIELDS = ["xpos", "ypos"] as const;

export type ConflictDecision =
  /** Re-send the same write with `version`. */
  | { kind: "rebase"; version: string }
  /** Both sides moved the control: the user keeps theirs or ours. */
  | { kind: "moved"; version: string; theirs: Pt | null }
  /** Reload; the user redoes the edit. `differing` names what changed (items or fields), null when unknown. */
  | { kind: "refresh"; differing: string[] | null };

export interface ConflictWrite {
  /** Fields this write sets (`MOVE_FIELDS` for a move, `["structure"]` for a structure). */
  fields: readonly string[];
  /** A move: the position the client moved from (its base). */
  base?: Pt;
}

function positionOf(current: unknown): Pt | null {
  if (typeof current !== "object" || current === null) return null;
  const c = current as { xpos?: unknown; ypos?: unknown };
  return typeof c.xpos === "number" && typeof c.ypos === "number" ? { x: c.xpos, y: c.ypos } : null;
}

const isMove = (w: ConflictWrite) => w.fields.length === MOVE_FIELDS.length && MOVE_FIELDS.every((f) => w.fields.includes(f));

export function conflictDecision(conflict: VersionConflictData, write: ConflictWrite): ConflictDecision {
  if (conflict.kind === "course") return { kind: "refresh", differing: conflict.differing };
  if (isMove(write)) {
    const theirs = positionOf(conflict.current);
    const moved = conflict.differing
      ? conflict.differing.some((f) => (MOVE_FIELDS as readonly string[]).includes(f))
      // No base on this node: decide by where the control is now.
      : !theirs || !write.base || Math.abs(theirs.x - write.base.x) > 1e-9 || Math.abs(theirs.y - write.base.y) > 1e-9;
    return moved ? { kind: "moved", version: conflict.version, theirs } : { kind: "rebase", version: conflict.version };
  }
  if (conflict.differing && !conflict.differing.some((f) => write.fields.includes(f))) {
    return { kind: "rebase", version: conflict.version };
  }
  return { kind: "refresh", differing: conflict.differing };
}
