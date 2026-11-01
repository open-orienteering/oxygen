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
 * import-marked objects (importer); otherwise (backfill) an object an
 * import-marked one already equals is not written again, a course-scoped
 * one only adds its courses to the existing scope.
 */
export async function writeImportedObjects(
  db: Db,
  eventId: bigint,
  objects: readonly ImportedObject[],
  courseUuidOf: (name: string) => string | undefined,
  mode: { replace: boolean },
): Promise<number> {
  const existing = new Map<string, { id: string; scope: unknown }>();
  if (mode.replace) {
    await db.courseObject.deleteMany({ where: { eventId, source: "import" } });
  } else {
    const rows = await db.courseObject.findMany({ where: { eventId, source: "import" }, select: { id: true, kind: true, props: true, geometry: true, scope: true } });
    for (const r of rows) existing.set(keyOf(r), { id: r.id, scope: r.scope });
  }
  let written = 0;
  for (const o of objects) {
    let scope: { all: true } | { courses: string[]; classes: string[] };
    if (o.all) scope = { all: true };
    else {
      const courses = o.courseNames.flatMap((n) => courseUuidOf(n) ?? []);
      if (courses.length === 0) continue;
      scope = { courses, classes: [] };
    }
    const same = existing.get(keyOf(o.body));
    if (same) {
      const have = same.scope as { courses?: string[]; classes?: string[] };
      if (!("all" in scope) && Array.isArray(have.courses) && scope.courses.some((c) => !have.courses!.includes(c))) {
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
