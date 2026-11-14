/**
 * GPS tracks per event: storage (docs/map-gps-tracks.md §1; row G24;
 * slice G answer 10). One `map_gps_tracks` row per track segment, in
 * WGS 84; the device parses the GPX and the server validates the
 * `TrackPoints` columns (§2.1) — refusing, never re-rounding — and stores
 * them verbatim. Cloud-owned, not journaled, not in the checkout snapshot;
 * in the per-event dump (§1.3).
 */

import { TRPCError } from "@trpc/server";
import { encodeHlc, gpsTrack } from "@oxygen/shared";
import { Prisma, type PrismaClient } from "./generated/prisma/client.js";
import { nextServerHlc } from "./serverClock.js";

type TrackPoints = gpsTrack.TrackPoints;
type TrackRange = gpsTrack.TrackRange;

/** Caps (§1.2). */
export const MAX_TRACK_POINTS = 200_000;
export const MAX_EVENT_TRACKS = 200;
/** Points in one call, so a request stays well under Cloud Run's 32 MiB. */
export const MAX_CALL_POINTS = 500_000;

const MAX_LAT = 90 * gpsTrack.COORD_SCALE;
const MAX_LNG = 180 * gpsTrack.COORD_SCALE;
/** Interactive transactions: an import writes up to 500 000 points. */
const TX_OPTIONS = { timeout: 60_000, maxWait: 10_000 } as const;

type TrackErrorCode =
  | "TRACK_POINTS_INVALID"
  | "TRACK_TOO_MANY_POINTS"
  | "TRACK_REQUEST_TOO_LARGE"
  | "TRACK_LIMIT"
  | "TRACK_ID_TAKEN"
  | "TRACK_NOT_FOUND"
  | "TRACK_TRIM_INVALID"
  | "TRACK_SPLIT_INVALID";

const TRPC_CODE: Record<TrackErrorCode, TRPCError["code"]> = {
  TRACK_POINTS_INVALID: "BAD_REQUEST",
  TRACK_TOO_MANY_POINTS: "PAYLOAD_TOO_LARGE",
  TRACK_REQUEST_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  TRACK_LIMIT: "PRECONDITION_FAILED",
  TRACK_ID_TAKEN: "CONFLICT",
  TRACK_NOT_FOUND: "NOT_FOUND",
  TRACK_TRIM_INVALID: "BAD_REQUEST",
  TRACK_SPLIT_INVALID: "BAD_REQUEST",
};

function trackError(code: TrackErrorCode, message: string): TRPCError {
  return new TRPCError({ code: TRPC_CODE[code], message: `${code}: ${message}` });
}

// ---- validation (pure) --------------------------------------------------------

function isColumn(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

function coordinates(col: unknown, name: string, max: number): number[] {
  if (!isColumn(col)) throw trackError("TRACK_POINTS_INVALID", `${name} is not an array`);
  for (let i = 0; i < col.length; i++) {
    const v = col[i];
    if (typeof v !== "number" || !Number.isInteger(v) || v < -max || v > max) {
      throw trackError("TRACK_POINTS_INVALID", `${name}[${i}] is not an integer 1e-7° within ±${max / gpsTrack.COORD_SCALE}°`);
    }
  }
  return col as number[];
}

/** A nullable column of length `n`; null when every entry is null (§2.1). */
function optionalColumn(col: unknown, name: string, n: number, valid: (v: number) => boolean, what: string): (number | null)[] | null {
  if (col === null) return null;
  if (!isColumn(col)) throw trackError("TRACK_POINTS_INVALID", `${name} is neither null nor an array`);
  if (col.length !== n) throw trackError("TRACK_POINTS_INVALID", `${name} has ${col.length} entries, lat has ${n}`);
  let any = false;
  for (let i = 0; i < n; i++) {
    const v = col[i];
    if (v === null) continue;
    if (typeof v !== "number" || !valid(v)) throw trackError("TRACK_POINTS_INVALID", `${name}[${i}] is not ${what}`);
    any = true;
  }
  return any ? (col as (number | null)[]) : null;
}

const validTime = (v: number) => Number.isSafeInteger(v) && v >= 0;
const validEle = (v: number) => Number.isFinite(v) && gpsTrack.quantiseEle(v) === v;

/**
 * The stored form of `input`, or `TRACK_POINTS_INVALID` /
 * `TRACK_TOO_MANY_POINTS` (§1.2). Hand-written rather than Zod: a capped
 * track is 800 000 numbers.
 */
export function validateTrackPoints(input: unknown): TrackPoints {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw trackError("TRACK_POINTS_INVALID", "points is not an object");
  const p = input as Record<string, unknown>;
  if (!("time" in p) || !("ele" in p)) throw trackError("TRACK_POINTS_INVALID", "points needs lat, lng, time and ele");
  if (isColumn(p.lat) && p.lat.length > MAX_TRACK_POINTS) {
    throw trackError("TRACK_TOO_MANY_POINTS", `a track has ${p.lat.length} points (at most ${MAX_TRACK_POINTS})`);
  }
  const lat = coordinates(p.lat, "lat", MAX_LAT);
  const lng = coordinates(p.lng, "lng", MAX_LNG);
  const n = lat.length;
  if (lng.length !== n) throw trackError("TRACK_POINTS_INVALID", `lng has ${lng.length} entries, lat has ${n}`);
  if (n < 2) throw trackError("TRACK_POINTS_INVALID", `a track needs at least two points, this has ${n}`);
  const time = optionalColumn(p.time, "time", n, validTime, "a non-negative integer epoch ms");
  const ele = optionalColumn(p.ele, "ele", n, validEle, "a finite elevation rounded to 0.1 m");
  return { lat, lng, time, ele };
}

/** An average's single-pass ranges (§4.1): integers, `0 ≤ start < end ≤ n`, ascending, disjoint, never touching. */
export function validateSinglePass(ranges: readonly TrackRange[], n: number): TrackRange[] {
  let prevEnd = -1;
  for (const [i, { start, end }] of ranges.entries()) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > n || start >= end || start <= prevEnd) {
      throw trackError("TRACK_POINTS_INVALID", `singlePass[${i}] [${start}, ${end}) is not an ascending, disjoint, non-touching range of a ${n}-point track`);
    }
    prevEnd = end;
  }
  return ranges.map(({ start, end }) => ({ start, end }));
}

/** The first non-null time (`recorded_at`), or null. */
export function firstTime(points: TrackPoints): number | null {
  for (const t of points.time ?? []) if (t !== null) return t;
  return null;
}

/** A column of only nulls stored as null (§2.1); `splitTrack` keeps the array. */
function normalised(points: TrackPoints): TrackPoints {
  const allNull = (c: (number | null)[] | null) => c === null || c.every((v) => v === null);
  return { ...points, time: allNull(points.time) ? null : points.time, ele: allNull(points.ele) ? null : points.ele };
}

/** What a split carries into each part. */
export interface StoredTrackPart {
  points: TrackPoints;
  trimStart: number;
  trimEnd: number;
  singlePass: TrackRange[] | null;
}

/**
 * Split a stored track at the stored-point `index` (§1.2): `splitTrack`
 * on the full points, trims carried (left `[trimStart, index + 1)`, right
 * `[0, trimEnd − index)`), `singlePass` through `splitRanges`. `index`
 * must leave two visible points on each side, else `TRACK_SPLIT_INVALID`.
 */
export function splitStoredTrack(row: StoredTrackPart, index: number): [StoredTrackPart, StoredTrackPart] {
  const { trimStart, trimEnd } = row;
  if (!Number.isInteger(index) || index < trimStart + 1 || index > trimEnd - 2) {
    throw trackError("TRACK_SPLIT_INVALID", `splitting at ${index} must leave two points of the trim [${trimStart}, ${trimEnd}) on each side`);
  }
  const [a, b] = gpsTrack.splitTrack({ name: null, points: row.points }, index);
  const [ra, rb] = row.singlePass ? gpsTrack.splitRanges(row.singlePass, index) : [null, null];
  return [
    { points: normalised(a.points), trimStart, trimEnd: index + 1, singlePass: ra },
    { points: normalised(b.points), trimStart: 0, trimEnd: trimEnd - index, singlePass: rb },
  ];
}

// ---- rows ---------------------------------------------------------------------

/** The metadata every answer carries (§1.2). */
export interface TrackMeta {
  id: string;
  name: string | null;
  sourceName: string;
  pointCount: number;
  /** Epoch ms of the first recorded time, or null. */
  recordedAt: number | null;
  trim: TrackRange;
  derivedFrom: string[];
  singlePass: TrackRange[] | null;
  convertedOp: string | null;
  createdBy: string | null;
  /** ISO 8601. */
  createdAt: string;
  /** The row's token as a decimal string (an HLC above 2^53). */
  version: string;
}

export interface TrackWithPoints extends TrackMeta {
  points: TrackPoints;
}

const META_SELECT = {
  id: true,
  name: true,
  sourceName: true,
  pointCount: true,
  recordedAt: true,
  trimStart: true,
  trimEnd: true,
  derivedFrom: true,
  singlePass: true,
  convertedOp: true,
  createdBy: true,
  createdAt: true,
  version: true,
} as const satisfies Prisma.MapGpsTrackSelect;

type MetaRow = Prisma.MapGpsTrackGetPayload<{ select: typeof META_SELECT }>;

const LIST_ORDER = [{ createdAt: "asc" }, { id: "asc" }] as const satisfies Prisma.MapGpsTrackOrderByWithRelationInput[];

function metaOfRow(r: MetaRow): TrackMeta {
  return {
    id: r.id,
    name: r.name,
    sourceName: r.sourceName,
    pointCount: r.pointCount,
    recordedAt: r.recordedAt ? r.recordedAt.getTime() : null,
    trim: { start: r.trimStart, end: r.trimEnd },
    derivedFrom: r.derivedFrom,
    singlePass: (r.singlePass as TrackRange[] | null) ?? null,
    convertedOp: r.convertedOp,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    version: r.version.toString(),
  };
}

/** A fresh token: tracks carry no journal entry, so the node clock mints one (as `map_patches`). */
function nextTrackVersion(): bigint {
  return encodeHlc(nextServerHlc());
}

/** One writer per event at a time, so the 200-track count holds (§1.2). */
async function lockEventTracks(tx: Prisma.TransactionClient, eventId: bigint): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`map-gps-tracks:${eventId}`}))`;
}

async function assertRoom(tx: Prisma.TransactionClient, eventId: bigint, adding: number): Promise<void> {
  const have = await tx.mapGpsTrack.count({ where: { eventId } });
  if (have + adding > MAX_EVENT_TRACKS) {
    throw trackError("TRACK_LIMIT", `the event holds ${have} tracks; ${adding} more would pass ${MAX_EVENT_TRACKS}`);
  }
}

/** A client-minted id inserted meanwhile by another event's writer (a unique violation) is `TRACK_ID_TAKEN`, not a 500. */
async function createOrTaken<T>(id: string | undefined, create: () => Promise<T>): Promise<T> {
  try {
    return await create();
  } catch (e) {
    if (id && e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw trackError("TRACK_ID_TAKEN", `the id ${id} is taken`);
    }
    throw e;
  }
}

function notFound(id: string): TRPCError {
  return trackError("TRACK_NOT_FOUND", `no track ${id} in this event`);
}

// ---- reads --------------------------------------------------------------------

/** `mapTrack.list`: metadata in list order; never reads `points`. */
export async function listTracks(db: PrismaClient, eventId: bigint): Promise<TrackMeta[]> {
  const rows = await db.mapGpsTrack.findMany({ where: { eventId }, select: META_SELECT, orderBy: LIST_ORDER });
  return rows.map(metaOfRow);
}

/** `mapTrack.get`: one track with its points. */
export async function getTrack(db: PrismaClient, eventId: bigint, id: string): Promise<TrackWithPoints> {
  const row = await db.mapGpsTrack.findFirst({ where: { id, eventId }, select: { ...META_SELECT, points: true } });
  if (!row) throw notFound(id);
  return { ...metaOfRow(row), points: row.points as unknown as TrackPoints };
}

// ---- writes -------------------------------------------------------------------

export interface ImportItem {
  id?: string;
  name: string | null;
  sourceName: string;
  points: unknown;
  derivedFrom?: string[];
  singlePass?: TrackRange[];
}

/**
 * `mapTrack.import` (§1.2): validate every item, then insert in input
 * order in one transaction under the event lock. An id already in the
 * event is answered as stored; one in another event is `TRACK_ID_TAKEN`.
 */
export async function importTracks(db: PrismaClient, eventId: bigint, createdBy: string | null, items: readonly ImportItem[]): Promise<TrackMeta[]> {
  const total = items.reduce((s, it) => s + (isColumn((it.points as { lat?: unknown } | null)?.lat) ? ((it.points as { lat: unknown[] }).lat.length) : 0), 0);
  if (total > MAX_CALL_POINTS) {
    throw trackError("TRACK_REQUEST_TOO_LARGE", `the call holds ${total} points (at most ${MAX_CALL_POINTS}); send the tracks in several calls`);
  }
  const ids = items.flatMap((it) => (it.id ? [it.id] : []));
  if (new Set(ids).size !== ids.length) throw trackError("TRACK_POINTS_INVALID", "an id appears twice in the call");
  const prepared = items.map((it, i) => {
    let points: TrackPoints;
    try {
      points = validateTrackPoints(it.points);
    } catch (e) {
      if (e instanceof TRPCError) throw new TRPCError({ code: e.code, message: `${e.message} (track ${i})` });
      throw e;
    }
    if ((it.derivedFrom === undefined) !== (it.singlePass === undefined)) {
      throw trackError("TRACK_POINTS_INVALID", `track ${i}: derivedFrom and singlePass come together (an average) or not at all`);
    }
    if (it.derivedFrom && new Set(it.derivedFrom).size !== it.derivedFrom.length) {
      throw trackError("TRACK_POINTS_INVALID", `track ${i}: derivedFrom names a pass twice`);
    }
    const singlePass = it.singlePass ? validateSinglePass(it.singlePass, points.lat.length) : null;
    return { item: it, points, singlePass };
  });

  return db.$transaction(async (tx) => {
    await lockEventTracks(tx, eventId);
    const existing = ids.length
      ? await tx.mapGpsTrack.findMany({ where: { id: { in: ids } }, select: { ...META_SELECT, eventId: true } })
      : [];
    const stored = new Map(existing.map((r) => [r.id, r]));
    for (const r of existing) {
      if (r.eventId !== eventId) throw trackError("TRACK_ID_TAKEN", `the id ${r.id} belongs to another event`);
    }
    await assertRoom(tx, eventId, prepared.filter((p) => !(p.item.id && stored.has(p.item.id))).length);
    const out: TrackMeta[] = [];
    for (const { item, points, singlePass } of prepared) {
      const kept = item.id ? stored.get(item.id) : undefined;
      if (kept) {
        out.push(metaOfRow(kept));
        continue;
      }
      const t = firstTime(points);
      const row = await createOrTaken(item.id, () => tx.mapGpsTrack.create({
        data: {
          ...(item.id ? { id: item.id } : {}),
          eventId,
          name: item.name,
          sourceName: item.sourceName,
          points: points as unknown as Prisma.InputJsonValue,
          pointCount: points.lat.length,
          recordedAt: t === null ? null : new Date(t),
          trimStart: 0,
          trimEnd: points.lat.length,
          derivedFrom: item.derivedFrom ?? [],
          singlePass: singlePass === null ? Prisma.DbNull : (singlePass as unknown as Prisma.InputJsonValue),
          createdBy,
          version: nextTrackVersion(),
        },
        select: META_SELECT,
      }));
      out.push(metaOfRow(row));
    }
    return out;
  }, TX_OPTIONS);
}

/** `mapTrack.update` (§1.2): name and trim; a write that changes nothing keeps the version. */
export async function updateTrack(db: PrismaClient, eventId: bigint, id: string, change: { name?: string | null; trim?: TrackRange }): Promise<TrackMeta> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "oxygen"."map_gps_tracks" WHERE "id" = ${id}::uuid AND "event_id" = ${eventId} FOR UPDATE`;
    const row = await tx.mapGpsTrack.findFirst({ where: { id, eventId }, select: META_SELECT });
    if (!row) throw notFound(id);
    const data: Prisma.MapGpsTrackUpdateInput = {};
    if (change.name !== undefined && change.name !== row.name) data.name = change.name;
    if (change.trim) {
      const { start, end } = change.trim;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > row.pointCount || end - start < 2) {
        throw trackError("TRACK_TRIM_INVALID", `trim [${start}, ${end}) of a ${row.pointCount}-point track must keep at least two points`);
      }
      if (start !== row.trimStart) data.trimStart = start;
      if (end !== row.trimEnd) data.trimEnd = end;
    }
    if (Object.keys(data).length === 0) return metaOfRow(row);
    data.version = nextTrackVersion();
    return metaOfRow(await tx.mapGpsTrack.update({ where: { id }, data, select: META_SELECT }));
  });
}

/**
 * `mapTrack.split` (§1.2): replace the row with two in one transaction.
 * With `ids`, a repeat after success (the original gone, both parts
 * present in the event) answers the two rows.
 */
export async function splitTrackRow(db: PrismaClient, eventId: bigint, id: string, index: number, ids?: [string, string]): Promise<[TrackMeta, TrackMeta]> {
  if (ids && (ids[0] === ids[1] || ids.includes(id))) {
    throw trackError("TRACK_SPLIT_INVALID", "the parts' ids must differ from each other and from the original");
  }
  return db.$transaction(async (tx) => {
    await lockEventTracks(tx, eventId);
    const row = await tx.mapGpsTrack.findFirst({ where: { id, eventId }, select: { ...META_SELECT, points: true } });
    if (!row) {
      if (ids) {
        const parts = await tx.mapGpsTrack.findMany({ where: { id: { in: ids }, eventId }, select: META_SELECT });
        const a = parts.find((p) => p.id === ids[0]);
        const b = parts.find((p) => p.id === ids[1]);
        if (a && b) return [metaOfRow(a), metaOfRow(b)];
      }
      throw notFound(id);
    }
    if (ids) {
      const taken = await tx.mapGpsTrack.findFirst({ where: { id: { in: ids } }, select: { id: true } });
      if (taken) throw trackError("TRACK_ID_TAKEN", `the id ${taken.id} is taken`);
    }
    const parts = splitStoredTrack(
      { points: row.points as unknown as TrackPoints, trimStart: row.trimStart, trimEnd: row.trimEnd, singlePass: (row.singlePass as TrackRange[] | null) ?? null },
      index,
    );
    await assertRoom(tx, eventId, 1);
    const partIds: string[] = [];
    for (const [i, part] of parts.entries()) {
      const t = firstTime(part.points);
      const { id: partId } = await tx.mapGpsTrack.create({
          data: {
            ...(ids ? { id: ids[i] } : {}),
            eventId,
            name: row.name,
            sourceName: row.sourceName,
            points: part.points as unknown as Prisma.InputJsonValue,
            pointCount: part.points.lat.length,
            recordedAt: t === null ? null : new Date(t),
            trimStart: part.trimStart,
            trimEnd: part.trimEnd,
            derivedFrom: row.derivedFrom,
            singlePass: part.singlePass === null ? Prisma.DbNull : (part.singlePass as unknown as Prisma.InputJsonValue),
            convertedOp: row.convertedOp,
            createdBy: row.createdBy,
            version: nextTrackVersion(),
          },
          select: { id: true },
        });
      partIds.push(partId);
    }
    // The parts keep the original's import time exactly (µs; a JS Date holds ms).
    await tx.$executeRaw`
      UPDATE "oxygen"."map_gps_tracks" n SET "created_at" = o."created_at"
      FROM "oxygen"."map_gps_tracks" o
      WHERE o."id" = ${id}::uuid AND n."id" IN (${Prisma.join(partIds.map((p) => Prisma.sql`${p}::uuid`))})`;
    await tx.mapGpsTrack.delete({ where: { id } });
    const rows = await tx.mapGpsTrack.findMany({ where: { id: { in: partIds } }, select: META_SELECT });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return [metaOfRow(byId.get(partIds[0])!), metaOfRow(byId.get(partIds[1])!)];
  }, TX_OPTIONS);
}

/** `mapTrack.remove`: the event's rows among `ids`; unknown ids are ignored. */
export async function removeTracks(db: PrismaClient, eventId: bigint, ids: readonly string[]): Promise<number> {
  const { count } = await db.mapGpsTrack.deleteMany({ where: { eventId, id: { in: [...ids] } } });
  return count;
}

/** `mapTrack.markConverted`: set or clear `converted_op`; every id must be the event's, else nothing is written. */
export async function markTracksConverted(db: PrismaClient, eventId: bigint, marks: readonly { id: string; opId: string | null }[]): Promise<TrackMeta[]> {
  const ids = marks.map((m) => m.id);
  if (new Set(ids).size !== ids.length) throw trackError("TRACK_POINTS_INVALID", "an id appears twice in the call");
  return db.$transaction(async (tx) => {
    // The event lock: a concurrent split or remove cannot delete a row between the read and its update.
    await lockEventTracks(tx, eventId);
    const rows = await tx.mapGpsTrack.findMany({ where: { eventId, id: { in: ids } }, select: META_SELECT });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const missing = ids.find((i) => !byId.has(i));
    if (missing) throw notFound(missing);
    const out: TrackMeta[] = [];
    for (const { id, opId } of marks) {
      const row = byId.get(id)!;
      if (row.convertedOp === opId) {
        out.push(metaOfRow(row));
        continue;
      }
      out.push(metaOfRow(await tx.mapGpsTrack.update({ where: { id }, data: { convertedOp: opId, version: nextTrackVersion() }, select: META_SELECT })));
    }
    return out;
  });
}
