/**
 * The editor's live checks and KPIs (docs/course-editor.md §8): the shared
 * `courseChecks` over the page's data, the server's `DESCRIPTION_STALE`
 * added, the canvas markers, the length from the layer's legs and the
 * click-to-locate target.
 */

import { useCallback, useMemo } from "react";
import { course, type ControlInfo } from "@oxygen/shared";
import { trpc } from "../../lib/trpc";
import type { ToolShape } from "../../components/MapViewer";
import { explicitStructure, type SiteRow } from "../../lib/editor/sequence";
import { checkDocumentFor, checkGroupsOf, checkMarkers, checkSitesOf, checkStructureOf, legsLengthM, locateTarget, mergeChecks, type EditorCheck } from "../../lib/editor/checks";

export interface CourseChecksInput {
  /** The selected course (course view), else null: the event-wide codes only. */
  course: { id: number; name: string } | null;
  structure: course.WireCourseStructure | null;
  sites: readonly SiteRow[];
  controls: readonly ControlInfo[] | undefined;
  document: { hash: string; bytes: ArrayBuffer | Uint8Array } | null;
  mapScale: number | null;
  objects: readonly course.CourseObject[];
  derivation: course.CourseDerivation | null | undefined;
  /** The circle radius the markers are sized from, paper mm. */
  ringMm: number;
  /** How the view shows the variation groups (docs/course-editor.md §12): the leg checks follow the displayed path. */
  orders?: course.GroupOrders;
}

export interface CourseChecksResult {
  checks: EditorCheck[];
  markers: ToolShape[];
  /** From the layer's legs; null until the viewer has derived the course. */
  lengthM: number | null;
  locate: (c: EditorCheck) => { selectId: number | null; centre: { x: number; y: number } | null };
}

export function useCourseChecks(input: CourseChecksInput): CourseChecksResult {
  const { course: selected, structure, sites, controls, document, mapScale, objects, derivation, ringMm, orders } = input;
  const server = trpc.course.checks.useQuery({ courseId: selected?.id ?? 0 }, { enabled: selected !== null });
  const sheets = trpc.courseMap.list.useQuery(undefined, { staleTime: 60_000 });

  const checkSites = useMemo(() => checkSitesOf(sites, controls ?? []), [sites, controls]);
  const siteById = useMemo(() => new Map(checkSites.map((s) => [s.id, s] as const)), [checkSites]);
  const checkDoc = useMemo(() => (document ? checkDocumentFor(document.hash, document.bytes) : null), [document]);
  const windows = useMemo(
    // Each window with the part it prints (course-layer.md §11): `EXCHANGE_WITHOUT_SHEET`, per-part `CONTROL_OUTSIDE_SHEET`.
    () => (selected ? (sheets.data ?? []).flatMap((m) => (m.courseId === selected.id && m.resolved && m.kind === "course" ? [{ ...m.resolved.window, section: m.sectionIndex }] : [])) : []),
    [sheets.data, selected],
  );
  // The viewer's derivation is this course's only while it draws it alone.
  const ownDerivation = selected && derivation?.courses.length === 1 && derivation.courses[0].id === selected.name ? derivation : null;

  const explicit = useMemo(() => (selected && structure ? explicitStructure(structure, sites) : null), [selected, structure, sites]);
  const client = useMemo(() => course.courseChecks({
    structure: selected && explicit ? checkStructureOf(selected.id, explicit, orders) : null,
    // §9.2 VARIATION_*: the editor's, from the structure's groups.
    groups: explicit ? checkGroupsOf(explicit) : [],
    sites: checkSites,
    document: checkDoc,
    sheets: windows,
    objects,
    derivation: ownDerivation,
    mapScale,
  }), [selected, explicit, orders, checkSites, checkDoc, windows, objects, ownDerivation, mapScale]);

  const checks = useMemo(() => mergeChecks(client, selected ? server.data : []), [client, server.data, selected]);
  const markers = useMemo(() => checkMarkers(checks, siteById, ringMm), [checks, siteById, ringMm]);
  // A part drawn alone (Layout mode, §11) is not the course's length: the stored one stands in.
  const lengthM = useMemo(() => (ownDerivation?.courses[0]?.section ? null : legsLengthM(ownDerivation, mapScale)), [ownDerivation, mapScale]);
  const locate = useCallback((c: EditorCheck) => locateTarget(c, siteById), [siteById]);
  return { checks, markers, lengthM, locate };
}
