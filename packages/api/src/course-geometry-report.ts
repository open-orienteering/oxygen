/**
 * The `courses.geometry` comparison report over a database's events
 * (docs/course-layer.md §4 "Comparison"; research 09 §5, §10). Read-only:
 * it computes what `rebuildCourseGeometry` would write now and compares it
 * with the stored rows, without writing anything. The CLI is
 * `scripts/compare-course-geometry.ts`; numbers go into the spec.
 */

import type { course } from "@oxygen/shared";
import type { PrismaClient, Prisma } from "./generated/prisma/client.js";
import { editorCourseGeometry, loadCourseSequences } from "./course-geometry.js";
import {
  compareEditorGeometry,
  importedCourseFidelity,
  type EditorComparison,
  type GeometryLike,
  type ImportedFidelity,
} from "./course-geometry-compare.js";
import { loadEventCrs } from "./event-crs.js";
import { loadDocumentCutFeatures, loadEventCutFeatures, loadOcadCutFeatures } from "./event-map-objects.js";

type Db = PrismaClient | Prisma.TransactionClient;

export interface CourseReport {
  event: string;
  course: string;
  source: string;
  /** Editor courses: stored vs what C5 writes. */
  editor?: EditorComparison;
  /** Editor courses on a map with a document: the C5 output cut from the OCAD parse vs from the document. */
  documentVsOcad?: EditorComparison;
  /** Imported courses: what structure v1 would lose. */
  imported?: ImportedFidelity;
}

export interface EventReport {
  event: string;
  name: string;
  pipeline: string;
  /** Where the written cuts come from: `document`, `ocad`, `off` (toggle) or `none` (no map). */
  cutSource: string;
  hasDocument: boolean;
  courses: CourseReport[];
}

export interface GeometryReport {
  generatedAt: string;
  events: EventReport[];
}

/** Compare every non-removed course of the given events (default: all non-removed events). */
export async function buildGeometryReport(db: Db, opts: { eventNameIds?: string[] } = {}): Promise<GeometryReport> {
  const events = await db.event.findMany({
    where: { removed: false, ...(opts.eventNameIds ? { nameId: { in: opts.eventNameIds } } : {}) },
    select: { id: true, nameId: true, name: true, mapPipeline: true, autoOverprintCuts: true },
    orderBy: { id: "asc" },
  });
  const out: EventReport[] = [];
  for (const ev of events) {
    const scale = (await loadEventCrs(db, ev.id))?.scale ?? null;
    const written = await loadEventCutFeatures(db, ev.id, scale);
    const pin = await db.mapFile.findFirst({ where: { eventId: ev.id }, orderBy: { uploadedAt: "desc" }, select: { documentHash: true } });
    const docFeatures = pin?.documentHash ? await loadDocumentCutFeatures(db, pin.documentHash) : null;
    const ocadFeatures = docFeatures ? await loadOcadCutFeatures(db, ev.id, scale) : null;
    const cuts: readonly course.CutFeature[] | null = ev.autoOverprintCuts === false ? null : (written?.features ?? null);

    const rows = await db.course.findMany({
      where: { eventId: ev.id, removed: false },
      select: { id: true, name: true, geometry: true, geometrySource: true },
      orderBy: { seq: "asc" },
    });
    const sequences = await loadCourseSequences(db, ev.id, rows.filter((r) => r.geometrySource === "editor").map((r) => r.id));
    const courses: CourseReport[] = [];
    for (const row of rows) {
      const stored = row.geometry as unknown as GeometryLike | null;
      if (!stored?.features) continue;
      const base = { event: ev.nameId, course: row.name, source: row.geometrySource };
      if (row.geometrySource === "editor") {
        const s = sequences.get(row.id);
        if (!s) continue;
        const now = editorCourseGeometry(row.id, s.seq, s.orderMode, cuts);
        const r: CourseReport = { ...base, editor: compareEditorGeometry(stored, now) };
        if (docFeatures && ocadFeatures && cuts) {
          r.documentVsOcad = compareEditorGeometry(
            editorCourseGeometry(row.id, s.seq, s.orderMode, ocadFeatures),
            editorCourseGeometry(row.id, s.seq, s.orderMode, docFeatures),
          );
        }
        courses.push(r);
      } else {
        courses.push({ ...base, imported: importedCourseFidelity(stored, written?.features ?? null) });
      }
    }
    out.push({
      event: ev.nameId,
      name: ev.name,
      pipeline: ev.mapPipeline,
      cutSource: ev.autoOverprintCuts === false ? "off" : (written?.source ?? "none"),
      hasDocument: docFeatures !== null,
      courses,
    });
  }
  return { generatedAt: new Date().toISOString(), events: out };
}

export interface ReportTotals {
  events: number;
  editorCourses: number;
  staleCourses: number;
  circles: { compared: number; same: number; changed: number; added: number; removed: number; oldDeg: number; newDeg: number };
  legs: { compared: number; same: number; changed: number; added: number; removed: number; oldMm: number; newMm: number };
  documentVsOcad: { courses: number; differing: number };
  importedCourses: number;
  imported: { legs: number; preclippedLegs: number; bentLegs: number; maxBendMm: number; authoredCutControls: number; both: number; authoredOnly: number; automaticOnly: number; extras: Record<string, number> };
}

export function reportTotals(report: GeometryReport): ReportTotals {
  const t: ReportTotals = {
    events: report.events.length,
    editorCourses: 0,
    staleCourses: 0,
    circles: { compared: 0, same: 0, changed: 0, added: 0, removed: 0, oldDeg: 0, newDeg: 0 },
    legs: { compared: 0, same: 0, changed: 0, added: 0, removed: 0, oldMm: 0, newMm: 0 },
    documentVsOcad: { courses: 0, differing: 0 },
    importedCourses: 0,
    imported: { legs: 0, preclippedLegs: 0, bentLegs: 0, maxBendMm: 0, authoredCutControls: 0, both: 0, authoredOnly: 0, automaticOnly: 0, extras: {} },
  };
  for (const c of report.events.flatMap((e) => e.courses)) {
    if (c.editor) {
      t.editorCourses++;
      // A stale row's cuts differ because its controls moved, not because of the rule: counted apart.
      if (c.editor.structure.length > 0) {
        t.staleCourses++;
        continue;
      }
      t.circles.compared += c.editor.circles.compared;
      t.circles.same += c.editor.circles.same;
      for (const d of c.editor.circles.diffs) {
        t.circles[d.status]++;
        t.circles.oldDeg += d.oldWidth;
        t.circles.newDeg += d.newWidth;
      }
      t.legs.compared += c.editor.legs.compared;
      t.legs.same += c.editor.legs.same;
      for (const d of c.editor.legs.diffs) {
        t.legs[d.status]++;
        t.legs.oldMm += d.oldWidth;
        t.legs.newMm += d.newWidth;
      }
    }
    if (c.documentVsOcad) {
      t.documentVsOcad.courses++;
      if (c.documentVsOcad.circles.diffs.length + c.documentVsOcad.legs.diffs.length > 0) t.documentVsOcad.differing++;
    }
    if (c.imported) {
      const i = c.imported;
      t.importedCourses++;
      t.imported.legs += i.legs;
      t.imported.preclippedLegs += i.preclippedLegs;
      t.imported.bentLegs += i.bentLegs;
      t.imported.maxBendMm = Math.max(t.imported.maxBendMm, i.maxBendMm);
      t.imported.authoredCutControls += i.authoredCutControls;
      t.imported.both += i.cutAgreement.both;
      t.imported.authoredOnly += i.cutAgreement.authoredOnly;
      t.imported.automaticOnly += i.cutAgreement.automaticOnly;
      for (const [k, n] of Object.entries(i.extras)) t.imported.extras[k] = (t.imported.extras[k] ?? 0) + n;
    }
  }
  return t;
}

const f1 = (n: number) => n.toFixed(1);

/** The report as Markdown: totals, then one line per event and the differing courses. */
export function formatGeometryReport(report: GeometryReport): string {
  const t = reportTotals(report);
  const lines = [
    `# courses.geometry comparison — ${report.generatedAt}`,
    "",
    `${t.events} events, ${t.editorCourses} editor courses (${t.staleCourses} with a stale stored row), ${t.importedCourses} imported courses.`,
    "",
    "## Editor courses: stored vs written by C5",
    "",
    "| | compared | same | changed | added | removed | opened before → after (changed/added/removed) |",
    "|---|---|---|---|---|---|---|",
    `| circle cuts | ${t.circles.compared} | ${t.circles.same} | ${t.circles.changed} | ${t.circles.added} | ${t.circles.removed} | ${f1(t.circles.oldDeg)}° → ${f1(t.circles.newDeg)}° |`,
    `| leg gaps | ${t.legs.compared} | ${t.legs.same} | ${t.legs.changed} | ${t.legs.added} | ${t.legs.removed} | ${f1(t.legs.oldMm)} mm → ${f1(t.legs.newMm)} mm |`,
    "",
    `Document vs OCAD feature source (courses on a map with a document): ${t.documentVsOcad.differing} of ${t.documentVsOcad.courses} differ.`,
    "",
    "## Imported courses: what structure v1 carries (09 §10)",
    "",
    "| legs | preclipped | bent (> 0.1 mm) | max bend | controls with authored cuts | authored ∩ automatic | authored only | automatic only |",
    "|---|---|---|---|---|---|---|---|",
    `| ${t.imported.legs} | ${t.imported.preclippedLegs} | ${t.imported.bentLegs} | ${t.imported.maxBendMm.toFixed(2)} mm | ${t.imported.authoredCutControls} | ${t.imported.both} | ${t.imported.authoredOnly} | ${t.imported.automaticOnly} |`,
    "",
    `Course-level features: ${Object.entries(t.imported.extras).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}.`,
    "",
    "## Events",
    "",
    "| event | pipeline | cut source | document | courses |",
    "|---|---|---|---|---|",
    ...report.events.map((e) => `| ${e.event} | ${e.pipeline} | ${e.cutSource} | ${e.hasDocument ? "yes" : "no"} | ${e.courses.length} |`),
    "",
    "## Differing editor courses",
    "",
  ];
  for (const c of report.events.flatMap((e) => e.courses)) {
    const e = c.editor;
    if (!e || (e.structure.length === 0 && e.circles.diffs.length === 0 && e.legs.diffs.length === 0)) continue;
    lines.push(`- **${c.event} / ${c.course}**${e.structure.length ? ` (stale: ${e.structure.join("; ")})` : ""}`);
    for (const d of e.circles.diffs) lines.push(`  - circle ${d.key}: ${d.status}, ${f1(d.oldWidth)}° → ${f1(d.newWidth)}°`);
    for (const d of e.legs.diffs) lines.push(`  - leg ${d.key}: ${d.status}, ${d.oldWidth.toFixed(2)} mm → ${d.newWidth.toFixed(2)} mm`);
  }
  return lines.join("\n") + "\n";
}
