/**
 * A map's colour setting (docs/map-symbols.md §9.3 "Per map (row I6)",
 * docs/map-storage.md §2): the order its document is drawn in — the IOF
 * colour layers (`iof`, the default) or the map's own table (`source`,
 * the user's answer 1) — and its per-deviation overrides (answer 2; the
 * mechanism of row I5, written from the panel by row I7). Stored per club
 * map series (kept across its versions) and per event and source file in
 * `map_colour_settings`; every import of the map reads it, and the job
 * row snapshots it.
 */

import { mapImport } from "@oxygen/shared";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";

type Db = PrismaClient | Prisma.TransactionClient;

export type ColourOrder = mapImport.ColourOrder;
export type DeviationChoice = mapImport.DeviationChoice;

export interface MapColourSettings {
  order: ColourOrder;
  /** Per deviation key (`"upper>lower"`), only choices that differ from the default (`KEPT_BY_DEFAULT`), keys sorted. */
  deviations: Record<string, DeviationChoice>;
}

export const DEFAULT_COLOUR_SETTINGS: Readonly<MapColourSettings> = Object.freeze({ order: mapImport.DEFAULT_COLOUR_ORDER, deviations: Object.freeze({}) as Record<string, DeviationChoice> });

/** The default choice for a deviation key (the user's answer 2: roads over contours kept, every other dropped). */
export const defaultDeviationChoice = (key: string): DeviationChoice => (mapImport.KEPT_BY_DEFAULT.has(key) ? "keep" : "drop");

export const DEVIATION_KEY = /^[a-z0-9-]+>[a-z0-9-]+$/;

/** Drop choices equal to the default and sort the keys, so equal settings compare and serialise equal. */
export function normaliseColourSettings(s: { order: ColourOrder; deviations?: Readonly<Record<string, DeviationChoice>> }): MapColourSettings {
  const deviations: Record<string, DeviationChoice> = {};
  for (const key of Object.keys(s.deviations ?? {}).sort()) {
    const choice = s.deviations![key];
    if (choice !== defaultDeviationChoice(key)) deviations[key] = choice;
  }
  return { order: s.order, deviations };
}

/** A deviation override as the panel sets it (row I7): `keep` or `drop`, or `default` to remove the override (a reset). */
export type DeviationChoiceInput = DeviationChoice | "default";

/** The setting with one deviation's choice changed (row I7, `mapImport.setDeviation`); a choice equal to the default is none. */
export function withDeviationChoice(s: MapColourSettings, key: string, choice: DeviationChoiceInput): MapColourSettings {
  const deviations: Record<string, DeviationChoice> = { ...s.deviations };
  delete deviations[key];
  if (choice !== "default") deviations[key] = choice;
  return normaliseColourSettings({ order: s.order, deviations });
}

/** The deviation keys a stored document's report lists (`[]` in the map's own order). */
export function reportDeviationKeys(report: unknown): string[] {
  return ((report as ColourReport)?.colourStack?.layers?.deviations ?? []).map((d) => mapImport.deviationKey(d.upper, d.lower));
}

/** The `deviations` query of a picture URL for these overrides; `""` for none. */
export function pictureDeviationsQuery(deviations: Readonly<Record<string, DeviationChoice>>): string {
  return Object.entries(normaliseColourSettings({ order: "iof", deviations }).deviations).map(([k, c]) => `${k}:${c}`).join(",");
}

/** A stored setting (a row's columns, or a job's `colour` snapshot); anything malformed reads as the defaults. */
export function parseColourSettings(json: unknown): MapColourSettings {
  if (!json || typeof json !== "object" || Array.isArray(json)) return { ...DEFAULT_COLOUR_SETTINGS, deviations: {} };
  const o = json as { order?: unknown; deviations?: unknown };
  const order: ColourOrder = o.order === "source" ? "source" : "iof";
  const deviations: Record<string, DeviationChoice> = {};
  if (o.deviations && typeof o.deviations === "object" && !Array.isArray(o.deviations)) {
    for (const [key, choice] of Object.entries(o.deviations as Record<string, unknown>)) {
      if (DEVIATION_KEY.test(key) && (choice === "keep" || choice === "drop")) deviations[key] = choice;
    }
  }
  return normaliseColourSettings({ order, deviations });
}

/** The setting as a JSON column value (`map_import_jobs.colour`). */
export const colourSettingsJson = (s: MapColourSettings): Prisma.InputJsonObject => ({ order: s.order, deviations: { ...s.deviations } });

export function sameColourSettings(a: MapColourSettings, b: MapColourSettings): boolean {
  return JSON.stringify(normaliseColourSettings(a)) === JSON.stringify(normaliseColourSettings(b));
}

/** Stage 7's options for a setting (`importMapToDocument(…, { match })`, docs/map-import.md §2.2). */
export function matchColourOptions(s: MapColourSettings): Pick<mapImport.MatchDocumentOptions, "colourOrder" | "deviations"> {
  const n = normaliseColourSettings(s);
  return Object.keys(n.deviations).length ? { colourOrder: n.order, deviations: n.deviations } : { colourOrder: n.order };
}

interface ReportColourStack {
  order?: unknown;
  layers?: { deviations?: { upper: string; lower: string; kept: boolean; byDefault: boolean; impliedBy?: string[]; blockedBy?: string[] }[] };
}

/** The import report's colour stack and warnings, as far as this module reads them. */
type ColourReport = { colourStack?: ReportColourStack; warnings?: { code?: string }[] } | null | undefined;

/** Whether stage 7 fell back to the map's own order (`COLOUR_LAYERS_FAILED`, §9.3 "In the importer"). */
export function reportColourFallback(report: unknown): boolean {
  const warnings = (report as ColourReport)?.warnings;
  return Array.isArray(warnings) && warnings.some((w) => w?.code === "COLOUR_LAYERS_FAILED");
}

/** The order a stored document is drawn in (`header.colourOrder.order`, in the report as `colourStack.order`); `null` before `ocad-19`. */
export function reportColourOrder(report: unknown): ColourOrder | null {
  const order = (report as ColourReport)?.colourStack?.order;
  return order === "iof" || order === "source" ? order : null;
}

/**
 * The setting a stored document was built with, read from its report: the
 * order (a document that fell back to `source` from `iof` was asked for
 * `iof`), and the overrides from `layers.deviations` — an entry no override
 * decided (`byDefault`) is none; an override is `keep` when it was blocked
 * (wanted kept) or kept without being implied, else `drop`. A document
 * from before the colour layers (no `order`) counts as the defaults: it is
 * stale by its importer version anyway.
 */
export function colourSettingsOfReport(report: unknown): MapColourSettings {
  const stack = (report as ColourReport)?.colourStack;
  let order = reportColourOrder(report) ?? "iof";
  if (order === "source" && reportColourFallback(report)) order = "iof";
  const deviations: Record<string, DeviationChoice> = {};
  for (const d of stack?.layers?.deviations ?? []) {
    if (d.byDefault) continue;
    deviations[mapImport.deviationKey(d.upper, d.lower)] = d.blockedBy || (d.kept && !d.impliedBy) ? "keep" : "drop";
  }
  return normaliseColourSettings({ order, deviations });
}

/**
 * Whether a stored document is what importing its source under `settings`
 * gives, as far as the colour setting goes: the same order, and in `iof`
 * the same overrides among the deviations the document has (an override of
 * a pair the map does not have changes nothing). `source` ignores the
 * overrides, as stage 7 does.
 */
export function reportFollowsColour(report: unknown, settings: MapColourSettings): boolean {
  const built = colourSettingsOfReport(report);
  const asked = normaliseColourSettings(settings);
  if (built.order !== asked.order) return false;
  // A document asked for `iof` that fell back to `source` is what `iof` gives; `source` is never asked for it.
  if (asked.order === "source") return !reportColourFallback(report);
  const listed = new Set(((report as ColourReport)?.colourStack?.layers?.deviations ?? []).map((d) => mapImport.deviationKey(d.upper, d.lower)));
  const relevant = Object.fromEntries(Object.entries(asked.deviations).filter(([k]) => listed.has(k)));
  return JSON.stringify(relevant) === JSON.stringify(built.deviations);
}

/** A setting's identity: the normalised setting as canonical JSON (`map_document_colour_settings.colour_key`). */
export const colourSettingsKey = (s: MapColourSettings): string => JSON.stringify(colourSettingsJson(normaliseColourSettings(s)));

/**
 * The part of a setting that can change a document: in the map's own order
 * none of the overrides (stage 7 ignores them), in the IOF order only the
 * overrides of deviations the document lists (an override of a pair the
 * map does not have changes nothing).
 */
function relevantColourSettings(report: unknown, s: MapColourSettings): MapColourSettings {
  const n = normaliseColourSettings(s);
  if (n.order === "source") return { order: "source", deviations: {} };
  const listed = new Set(((report as ColourReport)?.colourStack?.layers?.deviations ?? []).map((d) => mapImport.deviationKey(d.upper, d.lower)));
  return { order: n.order, deviations: Object.fromEntries(Object.entries(n.deviations).filter(([k]) => listed.has(k))) };
}

/**
 * Whether a stored document is what importing its source under `settings`
 * gives (row I7; docs/map-storage.md §6.9): its report says so
 * (`reportFollowsColour`), or an import in that setting gave it — a
 * setting recorded for it in `map_document_colour_settings`. The report is
 * written once, by the document's first import, so an override that
 * changes no bytes is only known from the recorded settings.
 */
export function documentFollowsColour(doc: { report: unknown; recorded?: readonly MapColourSettings[] }, settings: MapColourSettings): boolean {
  if (reportFollowsColour(doc.report, settings)) return true;
  if (!doc.recorded?.length) return false;
  const asked = colourSettingsKey(relevantColourSettings(doc.report, settings));
  return doc.recorded.some((r) => colourSettingsKey(relevantColourSettings(doc.report, r)) === asked);
}

/** Record that importing a document's source in `settings` gave it (every finished import job, row I7). */
export async function recordDocumentColour(db: Db, documentHash: string, settings: MapColourSettings): Promise<void> {
  const n = normaliseColourSettings(settings);
  await db.mapDocumentColourSetting.createMany({ data: [{ documentHash, colourKey: colourSettingsKey(n), colour: colourSettingsJson(n) }], skipDuplicates: true });
}

/** The settings recorded for each of `hashes` (a hash without rows is absent). */
export async function loadRecordedColours(db: Db, hashes: readonly string[]): Promise<Map<string, MapColourSettings[]>> {
  const out = new Map<string, MapColourSettings[]>();
  if (!hashes.length) return out;
  const rows = await db.mapDocumentColourSetting.findMany({ where: { documentHash: { in: [...new Set(hashes)] } }, select: { documentHash: true, colour: true } });
  for (const r of rows) {
    const list = out.get(r.documentHash) ?? [];
    list.push(parseColourSettings(r.colour));
    out.set(r.documentHash, list);
  }
  return out;
}

// ---- the rows ------------------------------------------------------------------

/** Whose setting: a club map series, or an event's map of one source file. */
export type ColourTarget = { kind: "club"; clubMapId: string } | { kind: "event"; eventId: bigint; sourceHash: string };

const whereOf = (t: ColourTarget) =>
  t.kind === "club" ? { clubMapId: t.clubMapId } : { eventId_sourceHash: { eventId: t.eventId, sourceHash: t.sourceHash } };

const rowSettings = (row: { order: string; deviations: Prisma.JsonValue }): MapColourSettings => parseColourSettings({ order: row.order, deviations: row.deviations });

/** The target's setting; the defaults when it has no row. */
export async function loadColourSettings(db: Db, target: ColourTarget): Promise<MapColourSettings> {
  const row = await db.mapColourSetting.findUnique({ where: whereOf(target), select: { order: true, deviations: true } });
  return row ? rowSettings(row) : { ...DEFAULT_COLOUR_SETTINGS, deviations: {} };
}

/** Every stored row, keyed `club:<uuid>` and `event:<id>|<source hash>` (the re-match pass reads them once). */
export async function loadAllColourSettings(db: Db): Promise<Map<string, MapColourSettings>> {
  const rows = await db.mapColourSetting.findMany({ select: { clubMapId: true, eventId: true, sourceHash: true, order: true, deviations: true } });
  const out = new Map<string, MapColourSettings>();
  for (const r of rows) {
    if (r.clubMapId) out.set(colourTargetKey({ kind: "club", clubMapId: r.clubMapId }), rowSettings(r));
    else if (r.eventId !== null && r.sourceHash) out.set(colourTargetKey({ kind: "event", eventId: r.eventId, sourceHash: r.sourceHash }), rowSettings(r));
  }
  return out;
}

export const colourTargetKey = (t: ColourTarget): string => (t.kind === "club" ? `club:${t.clubMapId}` : `event:${t.eventId}|${t.sourceHash}`);

/** Write the target's setting (an upsert), normalised; returns what is stored. */
export async function writeColourSettings(db: Db, target: ColourTarget, settings: MapColourSettings, userId: string | null): Promise<MapColourSettings> {
  const n = normaliseColourSettings(settings);
  const data = { order: n.order, deviations: { ...n.deviations }, updatedBy: userId };
  const create = target.kind === "club" ? { clubMapId: target.clubMapId } : { eventId: target.eventId, sourceHash: target.sourceHash };
  await db.mapColourSetting.upsert({ where: whereOf(target), create: { ...create, ...data }, update: data });
  return n;
}

/**
 * The setting an import job for this target uses (docs/map-storage.md
 * §6.1): a club map's series' (also for a promote, which targets both),
 * else the event's for this source, else the defaults (a job without a
 * target: the caller passes the setting it wants).
 */
export async function colourSettingsForJob(db: Db, job: { clubMapId: string | null; eventId: bigint | null; sourceHash: string }): Promise<MapColourSettings> {
  if (job.clubMapId) return loadColourSettings(db, { kind: "club", clubMapId: job.clubMapId });
  if (job.eventId !== null) return loadColourSettings(db, { kind: "event", eventId: job.eventId, sourceHash: job.sourceHash });
  return { ...DEFAULT_COLOUR_SETTINGS, deviations: {} };
}

/**
 * `course.useClubMap` (docs/map-storage.md §6.5): the event's copy of a
 * club map takes the series' setting, as it takes the rotation correction
 * and the corrections; a series without a row leaves the event at the
 * defaults. Later changes on either side do not travel.
 */
export async function copyClubColourSettings(db: Db, clubMapId: string, eventId: bigint, sourceHash: string): Promise<void> {
  const row = await db.mapColourSetting.findUnique({ where: { clubMapId }, select: { order: true, deviations: true, updatedBy: true } });
  const target: ColourTarget = { kind: "event", eventId, sourceHash };
  if (row) await writeColourSettings(db, target, rowSettings(row), row.updatedBy);
  else await db.mapColourSetting.deleteMany({ where: { eventId, sourceHash } });
}
