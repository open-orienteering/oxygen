/**
 * Version tokens for the legacy editors (docs/course-layer.md §7 "Legacy
 * editor"): `CourseEditorPage` and the Courses page send `baseVersion` from
 * the rows they loaded, and on a version `CONFLICT` invalidate and show
 * "changed elsewhere — reloaded".
 *
 * The book holds the newest token seen per row — from the `course.list` /
 * `control.list` refetches and from each mutation's result — so a write
 * queued right after another (undo, redo, a drag then a description) sends
 * the token its predecessor produced rather than the one the last refetch
 * happened to carry.
 */

import { versionConflictOf, type VersionConflictData } from "@oxygen/shared";

/** Every row kind that carries a token (course objects since D2). */
export type VersionedKind = VersionConflictData["kind"];

export class VersionBook {
  private readonly tokens = new Map<string, bigint>();

  private key(kind: VersionedKind, id: number): string {
    return `${kind}:${id}`;
  }

  /** Record a token; an older one than the book holds is ignored. */
  seed(kind: VersionedKind, id: number, version: string): void {
    const v = BigInt(version);
    const key = this.key(kind, id);
    const known = this.tokens.get(key);
    if (known === undefined || v > known) this.tokens.set(key, v);
  }

  seedAll(kind: VersionedKind, rows: ReadonlyArray<{ id: number; version: string }>): void {
    for (const row of rows) this.seed(kind, row.id, row.version);
  }

  get(kind: VersionedKind, id: number): string | undefined {
    return this.tokens.get(this.key(kind, id))?.toString();
  }
}

/** The version-conflict payload of a tRPC client error, or null. */
export function versionConflictOfError(e: unknown): VersionConflictData | null {
  if (typeof e !== "object" || e === null || !("data" in e)) return null;
  return versionConflictOf((e as { data: unknown }).data);
}

/** A control's public id after a `codes` write: its new first code, else unchanged. */
export function publicIdAfterCodes(id: number, codes: string | undefined): number {
  if (codes === undefined) return id;
  const first = parseInt(codes.split(";")[0]?.trim() ?? "", 10);
  return Number.isFinite(first) && first > 0 ? first : id;
}
