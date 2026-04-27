import type { ClassInfo } from "@oxygen/shared";

export interface ClassFilterOptions {
  /** Runner's sex: "M", "F", or "" (unknown). Anything else is treated as unknown. */
  sex?: string;
  /** Runner's birth year (4-digit). 0 / undefined means unknown. */
  birthYear?: number;
  /** Year used to compute age. Falls back to current year. */
  competitionYear?: number;
}

/**
 * Filter the class list shown in the on-site registration dialog.
 *
 * Rules:
 *  1. Only classes flagged `allowQuickEntry` ever appear (direct registration).
 *  2. If the runner's sex is known ("M"/"F"), classes restricted to the
 *     opposite sex are hidden. Open classes (`sex === ""`) always remain.
 *     MeOS legacy data can store women as "W"; we treat W as F.
 *  3. If the runner's birth year is known, classes whose `lowAge`/`highAge`
 *     bracket excludes that age are hidden. Zero values disable that bound.
 */
export function filterRegistrationClasses(
  classes: ClassInfo[],
  opts: ClassFilterOptions = {},
): ClassInfo[] {
  const runnerSex = normalizeSex(opts.sex);
  const competitionYear = opts.competitionYear ?? new Date().getFullYear();
  const age =
    opts.birthYear && opts.birthYear > 0
      ? competitionYear - opts.birthYear
      : null;

  return classes.filter((c) => {
    if (!c.allowQuickEntry) return false;

    const classSex = normalizeSex(c.sex);
    if (runnerSex && classSex && runnerSex !== classSex) return false;

    if (age != null) {
      if (c.lowAge > 0 && age < c.lowAge) return false;
      if (c.highAge > 0 && age > c.highAge) return false;
    }

    return true;
  });
}

function normalizeSex(value: string | undefined): "M" | "F" | "" {
  if (!value) return "";
  const v = value.trim().toUpperCase();
  if (v.startsWith("M")) return "M";
  if (v.startsWith("F") || v.startsWith("W")) return "F";
  return "";
}

/**
 * Extract a 4-digit year from the start of a competition date string.
 * Falls back to the current year when no year can be parsed.
 */
export function competitionYearFromDate(date: string | undefined | null): number {
  if (date) {
    const m = /^(\d{4})/.exec(date);
    if (m) return parseInt(m[1], 10);
  }
  return new Date().getFullYear();
}
