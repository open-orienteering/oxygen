/**
 * Writing the course objects an import (or the structure backfill) read
 * from a file's geometry (docs/course-layer.md §6.4). Rows are marked
 * `source = 'import'`: a re-import replaces exactly those, never an object
 * drawn in the editor.
 */

import { nextObjectVersion, writeCourseObject } from "./course-objects.js";
import type { ImportedObject } from "./course-import-structure.js";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";

type Db = PrismaClient | Prisma.TransactionClient;

const keyOf = (body: { kind: string; props: unknown; geometry: unknown }) => JSON.stringify([body.kind, body.props, body.geometry]);

/**
 * Write `objects`, scoped by course name → uuid (an object whose courses
 * all fail to resolve is skipped). `replace`: first delete the event's
 * import-marked objects whose scope names one of those courses (importer:
 * another file's objects survive); otherwise (backfill) an object an
 * import-marked one already equals is not written again, a course-scoped
 * one only adds its courses to the existing scope.
 */
export async function writeImportedObjects(
  db: Db,
  eventId: bigint,
  objects: readonly ImportedObject[],
  courseUuidOf: (name: string) => string | undefined,
  mode: { replace: boolean; rewrittenCourseNames?: readonly string[] },
): Promise<number> {
  const existing = new Map<string, { id: string; scope: unknown }>();
  if (mode.replace) {
    const mine = new Set(objects.flatMap((o) => o.courseNames.flatMap((n) => courseUuidOf(n) ?? [])));
    for (const n of mode.rewrittenCourseNames ?? []) {
      const u = courseUuidOf(n);
      if (u) mine.add(u);
    }
    const rows = await db.courseObject.findMany({ where: { eventId, source: "import" }, select: { id: true, scope: true } });
    const stale = rows.filter((r) => ((r.scope as { courses?: string[] }).courses ?? []).some((c) => mine.has(c))).map((r) => r.id);
    if (stale.length > 0) await db.courseObject.deleteMany({ where: { id: { in: stale } } });
  } else {
    const rows = await db.courseObject.findMany({ where: { eventId, source: "import" }, select: { id: true, kind: true, props: true, geometry: true, scope: true } });
    for (const r of rows) existing.set(keyOf(r), { id: r.id, scope: r.scope });
  }
  let written = 0;
  for (const o of objects) {
    const courses = o.courseNames.flatMap((n) => courseUuidOf(n) ?? []);
    if (courses.length === 0) continue;
    const scope = { courses, classes: [] as string[] };
    const same = existing.get(keyOf(o.body));
    if (same) {
      const have = same.scope as { courses?: string[]; classes?: string[] };
      if (Array.isArray(have.courses) && scope.courses.some((c) => !have.courses!.includes(c))) {
        await db.courseObject.update({
          where: { id: same.id },
          data: { scope: { courses: [...new Set([...have.courses, ...scope.courses])], classes: have.classes ?? [] }, version: nextObjectVersion() },
        });
      }
      continue;
    }
    await writeCourseObject(db, eventId, { body: o.body, scope, source: "import" });
    written++;
  }
  return written;
}
