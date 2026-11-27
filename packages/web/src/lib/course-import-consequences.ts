/**
 * The course import dialog's consequence list (course-layer.md §6.4
 * "Import semantics"): the server's per-mode plan, turned into the lines
 * the dialog shows for the selected mode and the operator's class mapping.
 */

export interface ModeConsequences {
  coursesAdded: string[];
  coursesUpdated: string[];
  coursesRestored: string[];
  coursesRemoved: string[];
  coursesSkippedForked: string[];
  coursesFlattened: Array<{ name: string; variants: number; runners: number }>;
  coursesLengthChanged: Array<{ name: string; fromM: number; toM: number }>;
  coursesKeepingLength: string[];
  coursesLengthDerived: string[];
  controlsAdded: number;
  controlsUpdated: number;
  controlsRestored: number;
  controlsRemoved: string[];
  controlsKeepingSettings: Array<{ code: string; status: string; codes: string }>;
  controlsMovedFar: Array<{ code: string; metres: number }>;
  runnersLosingVariant: number;
  runnersOnRemovedCourse: number;
  classesUnassigned: Array<{ seq: number; name: string; courseName: string }>;
}

export type ConsequenceTone = "remove" | "keep" | "warn" | "info";

export interface ConsequenceLine {
  /** i18n key under `courses:consequence.` */
  key: Exclude<keyof ModeConsequences, "coursesRestored" | "controlsRestored">;
  tone: ConsequenceTone;
  count: number;
  names: string[];
}

/**
 * The lines for one mode, non-zero ones only, removals first. A class the
 * mapping puts back on a course is not counted as unassigned.
 */
export function consequenceLines(
  c: ModeConsequences,
  classMapping: Record<string, number[]>,
): ConsequenceLine[] {
  const remapped = new Set(Object.values(classMapping).flat().filter((seq) => seq > 0));
  const unassigned = c.classesUnassigned.filter((cl) => !remapped.has(cl.seq));
  const lines: ConsequenceLine[] = [
    { key: "coursesRemoved", tone: "remove", count: c.coursesRemoved.length, names: c.coursesRemoved },
    { key: "controlsRemoved", tone: "remove", count: c.controlsRemoved.length, names: c.controlsRemoved },
    { key: "classesUnassigned", tone: "remove", count: unassigned.length, names: unassigned.map((cl) => `${cl.name} (${cl.courseName})`) },
    {
      key: "coursesFlattened",
      tone: "remove",
      count: c.coursesFlattened.length,
      names: c.coursesFlattened.map((f) => f.name),
    },
    { key: "runnersLosingVariant", tone: "remove", count: c.runnersLosingVariant, names: [] },
    { key: "runnersOnRemovedCourse", tone: "remove", count: c.runnersOnRemovedCourse, names: [] },
    { key: "coursesLengthChanged", tone: "warn", count: c.coursesLengthChanged.length, names: c.coursesLengthChanged.map((l) => `${l.name}: ${l.fromM} → ${l.toM} m`) },
    { key: "controlsMovedFar", tone: "warn", count: c.controlsMovedFar.length, names: c.controlsMovedFar.map((m) => `${m.code} (${m.metres} m)`) },
    { key: "coursesSkippedForked", tone: "keep", count: c.coursesSkippedForked.length, names: c.coursesSkippedForked },
    { key: "controlsKeepingSettings", tone: "keep", count: c.controlsKeepingSettings.length, names: c.controlsKeepingSettings.map((k) => k.codes || k.code) },
    { key: "coursesKeepingLength", tone: "keep", count: c.coursesKeepingLength.length, names: c.coursesKeepingLength },
    { key: "coursesLengthDerived", tone: "info", count: c.coursesLengthDerived.length, names: c.coursesLengthDerived },
    { key: "coursesAdded", tone: "info", count: c.coursesAdded.length, names: c.coursesAdded },
    { key: "coursesUpdated", tone: "info", count: c.coursesUpdated.length + c.coursesRestored.length, names: [...c.coursesUpdated, ...c.coursesRestored] },
    { key: "controlsAdded", tone: "info", count: c.controlsAdded, names: [] },
    { key: "controlsUpdated", tone: "info", count: c.controlsUpdated + c.controlsRestored, names: [] },
  ];
  return lines.filter((l) => l.count > 0);
}
