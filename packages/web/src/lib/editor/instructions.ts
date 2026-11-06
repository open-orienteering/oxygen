/**
 * Course-level description instructions as the course inspector edits them
 * (docs/course-editor.md §4; `courses.description_instructions`): the finish
 * variant (14.x) with an optional length, and the special-instruction rows
 * (13.x) anchored after the start or after a control (public id). Pure: the
 * page writes the result through `course.update { descriptionInstructions }`
 * with the course's token, and its undo writes the previous value back.
 */

import { pruneDescriptionInstructions, type CourseDescriptionInstructions } from "@oxygen/shared";

export type Instructions = CourseDescriptionInstructions | null;
type Special = NonNullable<CourseDescriptionInstructions["specials"]>[number];

/** The sheet's finish row when the course stores none (`buildDescriptionSheet`). */
export const DEFAULT_FINISH_KIND = "14.3";
/** A new special row's kind: taped route away from control. */
export const DEFAULT_SPECIAL_KIND = "13.1";

function cleanLength(m: number | null | undefined): number | undefined {
  return m != null && Number.isFinite(m) && m > 0 ? Math.round(m) : undefined;
}

/** Lengths that are not positive dropped, metres whole, no empty `specials`; nothing left → `null`. */
export function normaliseInstructions(x: Instructions | undefined): Instructions {
  if (!x) return null;
  const specials: Special[] = (x.specials ?? []).map((s) => {
    const lengthM = cleanLength(s.lengthM);
    return { afterControlId: s.afterControlId, kind: s.kind, ...(lengthM !== undefined ? { lengthM } : {}) };
  });
  const finishLength = cleanLength(x.finish?.lengthM);
  const finish = x.finish ? { kind: x.finish.kind, ...(finishLength !== undefined ? { lengthM: finishLength } : {}) } : undefined;
  if (specials.length === 0 && !finish) return null;
  return { ...(specials.length > 0 ? { specials } : {}), ...(finish ? { finish } : {}) };
}

/** The stored value as the inspector shows it: specials anchored on a control the course does not visit are left out. */
export function instructionsOnCourse(stored: Instructions | undefined, controlIds: Iterable<number>): Instructions {
  return normaliseInstructions(pruneDescriptionInstructions(stored ?? null, new Set(controlIds)));
}

/** The finish variant and / or length (`lengthM: null` clears it: the sheet prints the measured distance). */
export function setFinish(prev: Instructions, patch: { kind?: string; lengthM?: number | null }): Instructions {
  const kind = patch.kind ?? prev?.finish?.kind ?? DEFAULT_FINISH_KIND;
  const lengthM = patch.lengthM === undefined ? prev?.finish?.lengthM : patch.lengthM ?? undefined;
  return normaliseInstructions({ ...prev, finish: { kind, ...(lengthM !== undefined ? { lengthM } : {}) } });
}

/** A new special row at the end, after `afterControlId` (`null` = after the start). */
export function addSpecial(prev: Instructions, afterControlId: number | null): Instructions {
  return normaliseInstructions({ ...prev, specials: [...(prev?.specials ?? []), { afterControlId, kind: DEFAULT_SPECIAL_KIND }] });
}

/** One special row's anchor, kind or length (`lengthM: null` clears it). Out of range: unchanged. */
export function updateSpecial(
  prev: Instructions,
  index: number,
  patch: { afterControlId?: number | null; kind?: string; lengthM?: number | null },
): Instructions {
  const specials = prev?.specials ?? [];
  if (index < 0 || index >= specials.length) return prev;
  const s = specials[index];
  const lengthM = patch.lengthM === undefined ? s.lengthM : patch.lengthM ?? undefined;
  const next: Special = {
    afterControlId: patch.afterControlId !== undefined ? patch.afterControlId : s.afterControlId,
    kind: patch.kind ?? s.kind,
    ...(lengthM !== undefined ? { lengthM } : {}),
  };
  return normaliseInstructions({ ...prev, specials: specials.map((x, i) => (i === index ? next : x)) });
}

/** Drop one special row. */
export function removeSpecial(prev: Instructions, index: number): Instructions {
  return normaliseInstructions({ ...prev, specials: (prev?.specials ?? []).filter((_, i) => i !== index) });
}

/** A length field's text: blank, not a number or not positive → `null` (unset); else whole metres. A decimal comma is read. */
export function parseLengthM(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}
