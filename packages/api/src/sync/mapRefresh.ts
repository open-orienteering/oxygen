/**
 * A box follows the cloud's map rows during a lease (row G19,
 * docs/map-storage.md §7.2 "Following the cloud during a lease").
 *
 * The event's map files, documents and sources, its patch, templates,
 * sheets, course objects, graphics and the classes' print overrides are
 * cloud-owned: their writes are forwarded from a box (row G18). While this
 * node holds the event's lease and the cloud answers, the refresh pulls
 * them through `lease.exportMapRows` (rows without bytes, built by the
 * checkout's own exporters) and makes the box's copy equal to what a fresh
 * checkout would hold. Every network read — the rows, then each blob and
 * graphic the box does not hold, checked for size and hash — happens
 * before one transaction, so any failure writes nothing and the box keeps
 * what it has.
 *
 * Nothing race-critical is written: of the journaled tables only the two
 * cloud-owned layout columns of `classes` (`print_scale`,
 * `sheet_template_id`, stripped from `class.upserted`), with no journal
 * entry.
 */

import { TRPCError } from "@trpc/server";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import type { EventRef } from "../db.js";
import { getActiveLease, NULLABLE_JSON_SHEET_FIELDS, TOKEN_TABLES, type LeasePeer, type TokenTable } from "./lease.js";
import { nodeId } from "./nodeIdentity.js";
import { withoutDroppedFields } from "./dropped-columns.js";
import {
  applyTokens,
  createSnapshotMapFiles,
  createSnapshotPatch,
  exportSnapshotMaps,
  fetchSnapshotBlobs,
  insertSnapshotBlobs,
  tokenMapOf,
  withDbNulls,
  type SnapshotBlobs,
  type SnapshotMaps,
} from "./snapshotMaps.js";
import {
  exportSnapshotGraphics,
  fetchSnapshotGraphics,
  mirrorSnapshotGraphics,
  type GraphicMirrorCounts,
  type SnapshotGraphic,
  type SnapshotGraphicBlobs,
} from "./snapshotGraphics.js";

type Row = Record<string, unknown>;

/** The cloud-owned layout tables, mirrored by id. */
export type LayoutTable = TokenTable;

/** The two cloud-owned layout columns of a class (docs/course-layout.md §6). */
export interface ClassOverride {
  id: string;
  printScale: number | null;
  sheetTemplateId: string | null;
}

/** `lease.exportMapRows`: the event's cloud-owned map rows, without bytes. */
export interface MapRows {
  /** The snapshot's `maps` part, without `decisions`. */
  maps: SnapshotMaps;
  /** Rows verbatim, as in the snapshot's `tables`. */
  tables: Record<LayoutTable, Row[]>;
  /** Exact tokens by row id, decimal strings (the rows' `version` is rounded over JSON). */
  versions: Partial<Record<LayoutTable, Record<string, string>>>;
  /** The snapshot's `graphics` part. */
  graphics?: SnapshotGraphic[];
  classOverrides: ClassOverride[];
}

export interface TableCounts {
  created: number;
  updated: number;
  deleted: number;
}

export interface MapRefreshResult {
  /** `map_files` rows written (0 when the set is unchanged). */
  mapFiles: number;
  patch: "unchanged" | "written" | "deleted";
  graphics: GraphicMirrorCounts;
  templates: TableCounts;
  /** Classes whose print override changed. */
  classes: number;
  /** `skipped`: cloud sheets whose course or class is not on the box. */
  sheets: TableCounts & { skipped: number };
  objects: TableCounts;
  /** Blob and graphic bytes fetched from the cloud. */
  fetchedBytes: number;
}

/** Rows and columns the refresh wrote — 0 when the cloud did not change. */
export function refreshWrites(r: MapRefreshResult): number {
  const t = (c: TableCounts) => c.created + c.updated + c.deleted;
  return (
    r.mapFiles +
    (r.patch === "unchanged" ? 0 : 1) +
    r.graphics.written +
    r.graphics.updated +
    r.graphics.deleted +
    t(r.templates) +
    r.classes +
    t(r.sheets) +
    t(r.objects)
  );
}

// ---- pure helpers -----------------------------------------------------------

/** JSON with sorted keys; a Date as its ISO string and a BigInt as its decimal, as they cross HTTP. */
export function canonicalJson(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (typeof v === "bigint") return JSON.stringify(v.toString());
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const toJson = (v as { toJSON?: () => unknown }).toJSON;
    if (typeof toJson === "function") return canonicalJson(toJson.call(v));
    const entries = Object.entries(v as Row)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Never compared: the local event id, the box trigger's `updated_at`, and the token (compared exactly apart). */
const IGNORED_LAYOUT_FIELDS = new Set(["eventId", "updatedAt", "version"]);

/** A row's content on `keys` (the cloud row's columns), as canonical JSON. */
export function rowContent(row: Row, keys: readonly string[], ignored: ReadonlySet<string> = IGNORED_LAYOUT_FIELDS): string {
  const picked: Row = {};
  for (const k of [...keys].sort()) if (!ignored.has(k)) picked[k] = row[k] ?? null;
  return canonicalJson(picked);
}

function tokenOf(row: Row): string | null {
  const v = row.version;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v).toString();
  if (typeof v === "string" && /^[0-9]+$/.test(v)) return v;
  return null;
}

export interface MirrorPlan {
  /** Local ids the cloud lacks, sorted. */
  deletes: string[];
  /** Cloud rows the box lacks. */
  creates: Row[];
  /** Cloud rows whose content or exact token differs from the box's. */
  updates: Row[];
}

/**
 * The writes that make `local` equal `cloud` by id. A row is changed when
 * its content on the cloud row's columns (less `eventId`, `updatedAt`,
 * `version`) or its exact token differs — never by `updated_at`, which the
 * box's trigger rewrites, nor by token alone (`courseObject.reorder` moves
 * `z` without a new token). `cloud` rows carry their exact tokens.
 */
export function planMirror(local: readonly Row[], cloud: readonly Row[]): MirrorPlan {
  const localById = new Map(local.map((r) => [String(r.id), r]));
  const cloudIds = new Set(cloud.map((r) => String(r.id)));
  const plan: MirrorPlan = {
    deletes: [...localById.keys()].filter((id) => !cloudIds.has(id)).sort(),
    creates: [],
    updates: [],
  };
  for (const c of cloud) {
    const l = localById.get(String(c.id));
    if (!l) {
      plan.creates.push(c);
      continue;
    }
    const keys = Object.keys(c);
    if (rowContent(l, keys) !== rowContent(c, keys) || tokenOf(l) !== tokenOf(c)) plan.updates.push(c);
  }
  return plan;
}

/** Never compared for `map_files`: the local identity and the venue NULL. */
const IGNORED_FILE_FIELDS = new Set(["id", "eventId", "clubMapVersionId"]);

/** Whether the box's `map_files` rows equal the cloud's as a multiset, on the cloud rows' columns. */
export function sameMapFiles(local: readonly Row[], cloud: readonly Row[]): boolean {
  if (local.length !== cloud.length) return false;
  const keys = [...new Set(cloud.flatMap((r) => Object.keys(r)))];
  const contents = (rows: readonly Row[]) => rows.map((r) => rowContent(r, keys, IGNORED_FILE_FIELDS)).sort();
  const a = contents(local);
  const b = contents(cloud);
  return a.every((x, i) => x === b[i]);
}

/** A sheet's reference to a template the export lacks becomes NULL, as at checkout. */
export function knownTemplateOf(templateIds: ReadonlySet<string>, v: unknown): string | null {
  return typeof v === "string" && templateIds.has(v) ? v : null;
}

/** The patch the box holds equals the export's: row, document, flags, JSON and exact token. */
function samePatch(
  local: { id: string; documentHash: string; enabled: boolean; ops: unknown; symbols: unknown; unresolved: unknown; version: bigint } | null,
  cloud: NonNullable<SnapshotMaps["patch"]>,
): boolean {
  return (
    local !== null &&
    local.id === cloud.id &&
    local.documentHash === cloud.documentHash &&
    local.enabled === cloud.enabled &&
    canonicalJson(local.ops) === canonicalJson(cloud.ops) &&
    canonicalJson(local.symbols) === canonicalJson(cloud.symbols) &&
    canonicalJson(local.unresolved) === canonicalJson(cloud.unresolved ?? {}) &&
    local.version.toString() === cloud.version
  );
}

// ---- exporter (cloud) -------------------------------------------------------

/**
 * `lease.exportMapRows`: the parts a checkout would carry for the event's
 * cloud-owned map rows, read in one repeatable-read transaction so a sheet
 * never arrives without the template it names.
 */
export async function exportMapRows(db: PrismaClient, eventId: bigint): Promise<MapRows> {
  return db.$transaction((tx) => readMapRows(tx, eventId), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    timeout: 60_000,
  });
}

async function readMapRows(tx: Prisma.TransactionClient, eventId: bigint): Promise<MapRows> {
  const mapTemplate = await tx.mapTemplate.findMany({ where: { eventId }, orderBy: { seq: "asc" } });
  const courseMap = await tx.courseMap.findMany({ where: { eventId }, orderBy: { seq: "asc" } });
  const courseObject = await tx.courseObject.findMany({ where: { eventId }, orderBy: { seq: "asc" } });
  const classOverrides = await tx.class.findMany({
    where: { eventId },
    select: { id: true, printScale: true, sheetTemplateId: true },
    orderBy: { seq: "asc" },
  });
  const tables = { mapTemplate, courseMap, courseObject } as unknown as Record<LayoutTable, Row[]>;
  return {
    maps: await exportSnapshotMaps(tx, eventId, { decisions: false }),
    tables,
    versions: Object.fromEntries(TOKEN_TABLES.map((t) => [t, tokenMapOf(tables[t])])),
    graphics: await exportSnapshotGraphics(tx, eventId),
    classOverrides,
  };
}

// ---- applier (box) ----------------------------------------------------------

/** Delegate lookup that keeps Prisma's per-model types out of the mirror. */
function layoutDelegate(tx: Prisma.TransactionClient, table: LayoutTable) {
  return tx[table] as unknown as {
    findMany(args: { where: { eventId: bigint } }): Promise<Row[]>;
    deleteMany(args: { where: { eventId: bigint; id: { in: string[] } } }): Promise<{ count: number }>;
    update(args: { where: { id: string }; data: Row }): Promise<unknown>;
    create(args: { data: Row }): Promise<unknown>;
  };
}

const SEQ_TABLE_NAMES: Record<LayoutTable, string> = {
  mapTemplate: "map_templates",
  courseMap: "course_maps",
  courseObject: "course_objects",
};

/** The row as an update writes it: neither identity, event, nor the trigger's `updated_at`. */
function updateData(r: Row): Row {
  const { id: _id, eventId: _eventId, updatedAt: _updatedAt, ...rest } = r;
  return rest;
}

/**
 * Mirror one layout table by id: deletes, then updates in place, then
 * creates (never delete and reinsert: a template delete nulls the classes'
 * and sheets' references), then the table's `event_seqs` counter raised
 * past the largest seq of the export's rows (skipped ones included) and
 * the box's. `prepare` normalises a cloud row for this box.
 */
async function mirrorLayoutTable(
  tx: Prisma.TransactionClient,
  eventId: bigint,
  table: LayoutTable,
  cloudRows: readonly Row[],
  plan: MirrorPlan,
  prepare: (r: Row) => Row,
  beforeUpdates?: (updates: readonly Row[]) => Promise<void>,
): Promise<TableCounts> {
  const d = layoutDelegate(tx, table);
  const deleted = plan.deletes.length > 0 ? (await d.deleteMany({ where: { eventId, id: { in: plan.deletes } } })).count : 0;
  if (beforeUpdates) await beforeUpdates(plan.updates);
  for (const u of plan.updates) await d.update({ where: { id: String(u.id) }, data: updateData(prepare(u)) });
  for (const c of plan.creates) await d.create({ data: { ...prepare(c), eventId } });
  const cloudMax = cloudRows.reduce((m, r) => (typeof r.seq === "number" && r.seq > m ? r.seq : m), 0);
  if (cloudMax > 0) {
    // A row the box creates later must not take a seq a cloud row holds.
    // No write when the counter is already past it.
    const name = SEQ_TABLE_NAMES[table];
    await tx.$executeRaw`
      INSERT INTO oxygen.event_seqs (event_id, table_name, next_seq)
      SELECT ${eventId}, ${name}, GREATEST(${cloudMax}::int, COALESCE(MAX(seq), 0)) + 1 FROM oxygen.${Prisma.raw(name)} WHERE event_id = ${eventId}
      ON CONFLICT (event_id, table_name) DO UPDATE SET next_seq = EXCLUDED.next_seq
        WHERE oxygen.event_seqs.next_seq < EXCLUDED.next_seq`;
  }
  return { created: plan.creates.length, updated: plan.updates.length, deleted };
}

/**
 * Apply `rows` to the box's live event inside one transaction, in FK order
 * (docs/map-storage.md §7.2 "Apply"). `blobs` and `graphicBlobs` are what
 * the fetch before the transaction brought; `fetchedBytes` is left 0.
 */
export async function applyMapRows(
  tx: Prisma.TransactionClient,
  eventId: bigint,
  rows: MapRows,
  blobs: SnapshotBlobs,
  graphicBlobs: SnapshotGraphicBlobs,
): Promise<MapRefreshResult> {
  // (1) Blobs, append-only. (2) The event's map files, as a set.
  await insertSnapshotBlobs(tx, rows.maps, blobs);
  const cloudFiles = rows.maps.files.map((f) => withoutDroppedFields("mapFile", f));
  const localFiles = (await tx.mapFile.findMany({ where: { eventId } })) as unknown as Row[];
  let mapFiles = 0;
  if (!sameMapFiles(localFiles, cloudFiles)) {
    await tx.mapFile.deleteMany({ where: { eventId } });
    await createSnapshotMapFiles(tx, eventId, cloudFiles, blobs);
    mapFiles = cloudFiles.length + localFiles.length;
  }

  // (3) The patch: the export's, or none (absent, or dormant on the cloud).
  const localPatch = await tx.mapPatch.findUnique({
    where: { eventId },
    select: { id: true, documentHash: true, enabled: true, ops: true, symbols: true, unresolved: true, version: true },
  });
  let patch: MapRefreshResult["patch"] = "unchanged";
  if (!rows.maps.patch) {
    if (localPatch) {
      await tx.mapPatch.delete({ where: { eventId } });
      patch = "deleted";
    }
  } else if (!samePatch(localPatch, rows.maps.patch)) {
    if (localPatch) await tx.mapPatch.delete({ where: { eventId } });
    await createSnapshotPatch(tx, eventId, rows.maps.patch);
    patch = "written";
  }

  // (4) Graphics by the cloud's id.
  const graphics = rows.graphics
    ? await mirrorSnapshotGraphics(tx, eventId, rows.graphics, graphicBlobs)
    : { written: 0, updated: 0, deleted: 0 };

  // (5) Templates. `UNIQUE (event_id, name)` and the one-auto-per-key
  // index are not deferrable, and one cloud edit can move two rows (a key
  // change promotes an extra): an updated template whose name, key or
  // extra flag changes is first parked under its UUID as an extra, then
  // every update writes the cloud's values.
  const cloudTemplates = applyTokens(rows.tables.mapTemplate ?? [], rows.versions.mapTemplate);
  const templateIds = new Set(cloudTemplates.map((r) => String(r.id)));
  const localTemplates = await layoutDelegate(tx, "mapTemplate").findMany({ where: { eventId } });
  const localTemplateById = new Map(localTemplates.map((r) => [String(r.id), r]));
  const templates = await mirrorLayoutTable(tx, eventId, "mapTemplate", cloudTemplates, planMirror(localTemplates, cloudTemplates), (r) => r, async (updates) => {
    for (const u of updates) {
      const l = localTemplateById.get(String(u.id));
      if (l && (l.name !== u.name || (l.autoKey ?? null) !== (u.autoKey ?? null) || l.isExtra !== u.isExtra)) {
        await tx.mapTemplate.update({ where: { id: String(u.id) }, data: { name: String(u.id), isExtra: true } });
      }
    }
  });

  // (6) The classes' two cloud-owned layout columns, and nothing else of them.
  const overrides = new Map(rows.classOverrides.map((o) => [o.id, o]));
  const localClasses = await tx.class.findMany({ where: { eventId }, select: { id: true, printScale: true, sheetTemplateId: true } });
  let classes = 0;
  for (const c of localClasses) {
    const o = overrides.get(c.id);
    if (!o) continue; // A class the cloud lacks is the box's own.
    const want = { printScale: o.printScale ?? null, sheetTemplateId: knownTemplateOf(templateIds, o.sheetTemplateId) };
    if (c.printScale === want.printScale && c.sheetTemplateId === want.sheetTemplateId) continue;
    await tx.class.update({ where: { id: c.id }, data: want });
    classes++;
  }

  // (7) Sheets whose course and class are on the box; the others wait.
  const [courseIds, classIds] = await Promise.all([
    tx.course.findMany({ where: { eventId }, select: { id: true } }).then((r) => new Set(r.map((c) => c.id))),
    tx.class.findMany({ where: { eventId }, select: { id: true } }).then((r) => new Set(r.map((c) => c.id))),
  ]);
  const placeable = (r: Row) =>
    (r.courseId == null || courseIds.has(String(r.courseId))) && (r.classId == null || classIds.has(String(r.classId)));
  const cloudSheets = applyTokens(rows.tables.courseMap ?? [], rows.versions.courseMap).map((r) => ({
    ...r,
    templateId: knownTemplateOf(templateIds, r.templateId),
  }));
  const sheetPlan = planMirror(await layoutDelegate(tx, "courseMap").findMany({ where: { eventId } }), cloudSheets);
  const sheetSkipped = [...sheetPlan.creates, ...sheetPlan.updates].filter((r) => !placeable(r)).length;
  const sheetCounts = await mirrorLayoutTable(
    tx,
    eventId,
    "courseMap",
    cloudSheets,
    { deletes: sheetPlan.deletes, creates: sheetPlan.creates.filter(placeable), updates: sheetPlan.updates.filter(placeable) },
    (r) => withDbNulls(r, NULLABLE_JSON_SHEET_FIELDS),
  );

  // (8) Course objects.
  const cloudObjects = applyTokens(rows.tables.courseObject ?? [], rows.versions.courseObject);
  const objects = await mirrorLayoutTable(
    tx,
    eventId,
    "courseObject",
    cloudObjects,
    planMirror(await layoutDelegate(tx, "courseObject").findMany({ where: { eventId } }), cloudObjects),
    (r) => r,
  );

  return {
    mapFiles,
    patch,
    graphics,
    templates,
    classes,
    sheets: { ...sheetCounts, skipped: sheetSkipped },
    objects,
    fetchedBytes: 0,
  };
}

/** Refreshes of one event run one at a time on this node. */
const running = new Map<string, Promise<void>>();
async function oneAtATime<T>(eventId: bigint, fn: () => Promise<T>): Promise<T> {
  const key = eventId.toString();
  const prev = running.get(key) ?? Promise.resolve();
  const next = prev.then(fn);
  const settled = next.then(
    () => {},
    () => {},
  );
  running.set(key, settled);
  try {
    return await next;
  } finally {
    if (running.get(key) === settled) running.delete(key);
  }
}

/**
 * Pull the event's cloud-owned map rows and mirror them onto this node.
 * No-op (null) unless THIS node holds the event's active lease. Throws —
 * with nothing written — when the cloud is unreachable, predates
 * `exportMapRows`, or serves a blob or graphic that does not match.
 */
export async function refreshCloudOwnedMaps(
  db: PrismaClient,
  event: EventRef,
  peer: LeasePeer,
): Promise<MapRefreshResult | null> {
  const holds = async () => (await getActiveLease(db, event.id))?.holderNodeId === nodeId();
  if (!(await holds())) return null;
  return oneAtATime(event.id, async () => {
    // A refresh queued behind another runs only while the lease is still here.
    if (!(await holds())) return null;
    const rows = await peer.exportMapRows(event.nameId);
    if (!rows || !rows.maps || !rows.tables || !rows.versions || !Array.isArray(rows.classOverrides)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Refresh: the peer's map rows are malformed." });
    }
    const blobs = await fetchSnapshotBlobs(db, rows.maps, (table, hash, start, length) =>
      peer.exportBlob(event.nameId, { table, hash, start, length }),
    );
    const graphicBlobs = rows.graphics
      ? await fetchSnapshotGraphics(
          db,
          rows.graphics,
          (id, start, length) => peer.exportBlob(event.nameId, { table: "graphics", id, start, length }),
          { heldEventId: event.id },
        )
      : { bytes: new Map<string, Buffer>(), fetchedBytes: 0 };
    const result = await db.$transaction((tx) => applyMapRows(tx, event.id, rows, blobs, graphicBlobs), { timeout: 60_000 });
    return { ...result, fetchedBytes: blobs.fetchedBytes + graphicBlobs.fetchedBytes };
  });
}
