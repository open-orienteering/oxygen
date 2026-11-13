/**
 * Purple Pen (.ppen / CourseScribe) course writer.
 *
 * Counterpart to `ppen-course-parser.ts`. Emits a minimal but openable
 * `.ppen` document: event metadata, control sites with map-mm locations,
 * and normal courses as linked `<course-control>` lists. Print-area /
 * appearance defaults are set so Purple Pen opens the file without
 * prompting for missing required fields.
 *
 * Pure: takes the same `ExportControlSite` / `ExportCourse` shapes as
 * `iof-course-export.ts`. DB gathering lives in `course-export.ts`.
 */

import { XMLBuilder } from "fast-xml-parser";
import { course as courseShared } from "@oxygen/shared";
import type {
  CourseDataExport,
  ExportControlSite,
  ExportCourse,
} from "./iof-course-export.js";

/** Round to `d` decimals without exponent notation. */
function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export interface PpenExportInput extends CourseDataExport {
  /** Map file name written into `<map>` text content. */
  mapFileName?: string;
}

/**
 * Build a Purple Pen `.ppen` document.
 *
 * Every *placed* control is exported. Course controls referring to
 * unplaced controls are dropped, matching the IOF exporter.
 *
 * The course structure (row F9; docs/ppen-import-export.md): a variant is
 * an ordinary `kind="normal"` course (Purple Pen's own variations are not
 * written — the parser refuses them); a bent leg is a `<leg>` with
 * `<bends>`; crossing points are not written (sites nor rows), a map
 * exchange is a normal control. Purple Pen's bends are corners: a curved
 * leg (a bend with handles, F13) is written as its curve flattened at
 * 0.1 mm (user answer 2026-11-08 Q3), so a round trip keeps its shape and
 * length within that and comes back as corners.
 */
export function buildPpenXml(input: PpenExportInput): string {
  const placed = input.controls.filter((c) => (c.xMm !== 0 || c.yMm !== 0) && c.type !== "CrossingPoint");
  const byId = new Map<string, ExportControlSite>();
  for (const c of placed) if (!byId.has(c.id)) byId.set(c.id, c);
  const sites = [...byId.values()];

  // Internal sequential ids (ppen uses ints for every entity).
  let nextId = 1;
  const eventId = nextId++;
  const controlInternalId = new Map<string, number>();
  for (const site of sites) {
    controlInternalId.set(site.id, nextId++);
  }

  const mapScale = input.mapScale > 0 ? input.mapScale : 15000;
  const mapFileName = input.mapFileName?.trim() || "map.ocd";

  // Print area from control extent with a small margin.
  let left = -100;
  let top = 100;
  let right = 100;
  let bottom = -100;
  if (sites.length > 0) {
    const xs = sites.map((c) => c.xMm);
    const ys = sites.map((c) => c.yMm);
    const pad = 20;
    left = round(Math.min(...xs) - pad, 4);
    right = round(Math.max(...xs) + pad, 4);
    bottom = round(Math.min(...ys) - pad, 4);
    top = round(Math.max(...ys) + pad, 4);
  }

  const controlNodes = sites.map((site) => {
    const id = controlInternalId.get(site.id)!;
    const kind =
      site.type === "Start" ? "start"
        : site.type === "Finish" ? "finish"
          : "normal";
    const node: Record<string, unknown> = {
      "@_id": id,
      "@_kind": kind,
      location: {
        "@_x": round(site.xMm, 6),
        "@_y": round(site.yMm, 6),
      },
    };
    if (kind === "normal") {
      node.code = site.id;
    }
    if (kind === "finish") {
      node.description = { "@_box": "all", "@_iof-2004-ref": "14.3" };
    }
    return node;
  });

  const courseNodes: Record<string, unknown>[] = [];
  const courseControlNodes: Record<string, unknown>[] = [];
  /** `<leg>` bends by "<start control>><end control>" (internal ids): one per pair, first course wins. */
  const legBends = new Map<string, ReadonlyArray<{ x: number; y: number }>>();
  let order = 1;

  for (const course of input.courses) {
    const seq = course.controls.filter((cc) => cc.type !== "CrossingPoint" && byId.has(cc.controlId));
    for (let i = 1; i < seq.length; i++) {
      const bends = seq[i].bends;
      if (!bends?.length) continue;
      const key = `${controlInternalId.get(seq[i - 1].controlId)!}>${controlInternalId.get(seq[i].controlId)!}`;
      if (legBends.has(key)) continue;
      if (!courseShared.hasCurvedBends(bends)) {
        legBends.set(key, bends);
        continue;
      }
      // A curve: its flattened polyline's inner points, the sites excluded.
      const a = byId.get(seq[i - 1].controlId)!, b = byId.get(seq[i].controlId)!;
      const flat = courseShared.legPolylineOf({ x: a.xMm, y: a.yMm }, bends, { x: b.xMm, y: b.yMm }, courseShared.PPEN_FLATTEN_TOLERANCE_MM);
      legBends.set(key, flat.slice(1, -1));
    }
    if (seq.length === 0) continue;

    const courseId = nextId++;
    const ccIds = seq.map(() => nextId++);

    courseNodes.push({
      "@_id": courseId,
      "@_kind": "normal",
      "@_order": order++,
      name: course.name,
      labels: { "@_label-kind": "sequence-and-code" },
      first: { "@_course-control": ccIds[0] },
      "print-area": {
        "@_automatic": "false",
        "@_restrict-to-page-size": "true",
        "@_left": left,
        "@_top": top,
        "@_right": right,
        "@_bottom": bottom,
        "@_page-width": "827",
        "@_page-height": "1169",
        "@_page-margins": "0",
        "@_page-landscape": "false",
      },
      options: {
        "@_print-scale": String(mapScale),
        "@_hide-from-reports": "false",
        "@_description-kind": "symbols",
      },
    });

    for (let i = 0; i < seq.length; i++) {
      const cc = seq[i];
      const node: Record<string, unknown> = {
        "@_id": ccIds[i],
        "@_control": controlInternalId.get(cc.controlId)!,
      };
      if (i < seq.length - 1) {
        node.next = { "@_course-control": ccIds[i + 1] };
      }
      courseControlNodes.push(node);
    }
  }

  const root: Record<string, unknown> = {
    event: {
      "@_id": eventId,
      title: input.eventName,
      map: {
        "@_kind": "OCAD",
        "@_scale": String(mapScale),
        "@_ignore-missing-fonts": "false",
        "#text": mapFileName,
      },
      standards: { "@_map": "2017", "@_description": "2018" },
      "all-controls": {
        "@_print-scale": String(mapScale),
        "@_description-kind": "symbols",
      },
      "print-area": {
        "@_automatic": "false",
        "@_restrict-to-page-size": "true",
        "@_left": left,
        "@_top": top,
        "@_right": right,
        "@_bottom": bottom,
        "@_page-width": "827",
        "@_page-height": "1169",
        "@_page-margins": "0",
        "@_page-landscape": "false",
      },
      numbering: { "@_start": "31", "@_disallow-invertible": "false" },
      "punch-card": {
        "@_rows": "3",
        "@_columns": "8",
        "@_left-to-right": "true",
        "@_top-to-bottom": "false",
      },
      "course-appearance": {
        "@_scale-sizes": "RelativeToMap",
        "@_scale-sizes-circle-gaps": "true",
        "@_auto-leg-gap-size": "3.5",
        "@_blend-purple": "true",
        "@_blend-style": "blend",
      },
      descriptions: { "@_lang": "en-GB", "@_color": "black" },
      ocad: { "@_overprint-colors": "false" },
    },
  };

  if (controlNodes.length > 0) root.control = controlNodes;
  if (courseNodes.length > 0) root.course = courseNodes;
  if (courseControlNodes.length > 0) root["course-control"] = courseControlNodes;
  const legNodes = [...legBends].map(([key, bends]) => {
    const [start, end] = key.split(">");
    return {
      "@_id": nextId++,
      "@_start-control": start,
      "@_end-control": end,
      bends: { location: bends.map((b) => ({ "@_x": round(b.x, 6), "@_y": round(b.y, 6) })) },
    };
  });
  if (legNodes.length > 0) root.leg = legNodes;

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    format: true,
    suppressEmptyNode: true,
  });
  const body = builder.build({ "course-scribe-event": root });
  return `<?xml version="1.0" encoding="utf-8"?>\n${body}`;
}

/** Re-export types used by callers that only import the ppen module. */
export type { ExportControlSite, ExportCourse, CourseDataExport };
