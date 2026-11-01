/**
 * Writing the course objects an import (or the structure backfill) read
 * from a file's geometry (docs/course-layer.md §6.4). Rows are marked
 * `source = 'import'`: a re-import replaces exactly those, never an object
 * drawn in the editor.
 */

import { writeCourseObject } from "./course-objects.js";
import type { ImportedObject } from "./course-import-structure.js";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";

type Db = PrismaClient | Prisma.TransactionClient;

const keyOf = (body: { kind: string; props: unknown; geometry: unknown }) => JSON.stringify([body.kind, body.props, body.geometry]);

/**
 * Write `objects`, scoped by course name → uuid (an object whose courses
 * all fail to resolve is skipped). `replace`: first delete the event's
 * import-marked objects (importer); otherwise add only those an
 * import-marked object does not already equal (backfill).
 */
export async function writeImportedObjects(
  db: Db,
  eventId: bigint,
  objects: readonly ImportedObject[],
  courseUuidOf: (name: string) => string | undefined,
  mode: { replace: boolean },
): Promise<number> {
  let existing = new Set<string>();
  if (mode.replace) {
    await db.courseObject.deleteMany({ where: { eventId, source: "import" } });
  } else {
    const rows = await db.courseObject.findMany({ where: { eventId, source: "import" }, select: { kind: true, props: true, geometry: true } });
    existing = new Set(rows.map(keyOf));
  }
  let written = 0;
  for (const o of objects) {
    if (existing.has(keyOf(o.body))) continue;
    let scope: { all: true } | { courses: string[]; classes: string[] };
    if (o.all) scope = { all: true };
    else {
      const courses = o.courseNames.flatMap((n) => courseUuidOf(n) ?? []);
      if (courses.length === 0) continue;
      scope = { courses, classes: [] };
    }
    await writeCourseObject(db, eventId, { body: o.body, scope, source: "import" });
    written++;
  }
  return written;
}
