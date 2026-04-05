import { z } from "zod";
import { router, publicProcedure, competitionProcedure } from "../trpc.js";
import {
  fetchClassInfo,
  fetchClassBlob,
  fetchLiveloxEventClasses,
} from "../livelox/fetcher.js";
import { transformToReplayData } from "../livelox/transform.js";
import { ensureRoutesTable } from "../db.js";
import type { ReplayResult, ReplayWaypoint } from "@oxygen/shared";
import type { PrismaClient } from "@prisma/client";

// ─── Helpers ────────────────────────────────────────────────

/** Normalise a runner name for fuzzy matching. */
export function normName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface RunnerLookups {
  /** normName(fullName) → oRunner.Id  (cross-club fallback) */
  byFullName: Map<string, number>;
  /** oRunner.ExtId.toString() → oRunner.Id  (Eventor person ID — highest priority) */
  byExtId: Map<string, number>;
  /** oClub.ExtId.toString() → oClub.Id  (Eventor org ID) */
  clubByExtId: Map<string, number>;
  /** normName(oClub.Name) → oClub.Id  (club name string match) */
  clubByName: Map<string, number>;
  /** oClub.Id → [{id: oRunner.Id, norm: normName}] */
  runnersByClub: Map<number, Array<{ id: number; norm: string }>>;
}

/** Build all lookup structures needed for 3-priority runner matching. */
async function buildRunnerLookups(
  client: PrismaClient,
): Promise<RunnerLookups> {
  const [runners, clubs] = await Promise.all([
    client.oRunner.findMany({
      where: { Removed: false },
      select: { Id: true, Name: true, Club: true, ExtId: true, ExtId2: true },
    }),
    client.oClub.findMany({
      select: { Id: true, Name: true, ExtId: true },
    }),
  ]);

  const byFullName = new Map<string, number>();
  const byExtId = new Map<string, number>();
  const runnersByClub = new Map<number, Array<{ id: number; norm: string }>>();

  for (const r of runners) {
    byFullName.set(normName(r.Name), r.Id);
    if (r.ExtId !== BigInt(0)) byExtId.set(r.ExtId.toString(), r.Id);
    if (r.ExtId2 !== BigInt(0)) byExtId.set(r.ExtId2.toString(), r.Id);
    if (r.Club > 0) {
      let list = runnersByClub.get(r.Club);
      if (!list) { list = []; runnersByClub.set(r.Club, list); }
      list.push({ id: r.Id, norm: normName(r.Name) });
    }
  }

  const clubByExtId = new Map<string, number>();
  const clubByName = new Map<string, number>();
  for (const c of clubs) {
    if (c.ExtId !== BigInt(0)) {
      clubByExtId.set(c.ExtId.toString(), c.Id);
    }
    clubByName.set(normName(c.Name), c.Id);
  }

  return { byFullName, byExtId, clubByExtId, clubByName, runnersByClub };
}

/**
 * Match a Livelox participant to an oRunner.Id using three priority levels:
 *
 * 1. Eventor person ID (person.externalIdentifiers system=0) → oRunner.ExtId
 * 2. Club-scoped name match: resolve club via Eventor org ID or org name string,
 *    then match name within that club — strips middle names for robustness
 * 3. Cross-club full-name exact match (fallback, original behaviour)
 */
export function matchRunner(
  firstName: string,
  lastName: string,
  personExtId: string | null,
  orgExtId: string | null,
  orgName: string | null,
  lookups: RunnerLookups,
): number | null {
  // P1: Eventor person ID
  if (personExtId) {
    const id = lookups.byExtId.get(personExtId);
    if (id != null) return id;
  }

  // P2: Club-scoped name match
  // Resolve club: prefer Eventor org ID, fall back to club name string
  let clubId: number | null =
    (orgExtId && lookups.clubByExtId.get(orgExtId)) ||
    (orgName && lookups.clubByName.get(normName(orgName))) ||
    null;

  if (clubId != null) {
    const clubRunners = lookups.runnersByClub.get(clubId) ?? [];
    const fl = normName(`${firstName} ${lastName}`);
    const lf = normName(`${lastName} ${firstName}`);
    for (const r of clubRunners) {
      if (r.norm === fl || r.norm === lf) return r.id;
    }
    // Strip middle names: use only first word of firstName
    const first1 = firstName.trim().split(/\s+/)[0] ?? "";
    const fl2 = normName(`${first1} ${lastName}`);
    const lf2 = normName(`${lastName} ${first1}`);
    for (const r of clubRunners) {
      if (r.norm === fl2 || r.norm === lf2) return r.id;
    }
  }

  // P3: Cross-club exact name match
  const fl = normName(`${firstName} ${lastName}`);
  const lf = normName(`${lastName} ${firstName}`);
  const exact = lookups.byFullName.get(fl) ?? lookups.byFullName.get(lf);
  if (exact != null) return exact;

  // P3b: Cross-club middle-name strip (only when firstName has multiple words)
  const first1 = firstName.trim().split(/\s+/)[0] ?? "";
  if (first1 !== firstName.trim()) {
    const fl2 = normName(`${first1} ${lastName}`);
    const lf2 = normName(`${lastName} ${first1}`);
    return lookups.byFullName.get(fl2) ?? lookups.byFullName.get(lf2) ?? null;
  }

  return null;
}

/** Build a class-name-to-oClass-Id map (case-insensitive). */
async function buildClassNameMap(
  client: PrismaClient,
): Promise<Map<string, number>> {
  const classes = await client.oClass.findMany({
    where: { Removed: false },
    select: { Id: true, Name: true },
  });
  const map = new Map<string, number>();
  for (const c of classes) {
    map.set(c.Name.toLowerCase().trim(), c.Id);
  }
  return map;
}

// ─── Router ─────────────────────────────────────────────────

export const liveloxRouter = router({
  /**
   * Import a Livelox class directly by classId (standalone replay viewer).
   * The classId is the numeric ID from a Livelox viewer URL (?classId=...).
   */
  importClass: publicProcedure
    .input(z.object({ classId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const info = await fetchClassInfo(input.classId);
      const blob = await fetchClassBlob(info.classBlobUrl);
      return transformToReplayData(blob, {
        eventName: info.eventName,
        className: info.className,
        tileProxyBase: "/api/livelox-tile",
      });
    }),

  /**
   * Bulk-sync all classes from a Livelox event into oxygen_routes.
   * Matches participants to oRunner by name and classes to oClass by name.
   * Re-syncing a class replaces its existing routes.
   */
  sync: competitionProcedure
    .input(z.object({ liveloxEventId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;
      await ensureRoutesTable(client, ctx.dbName);

      // Fetch Livelox class list and all runner lookup structures in parallel
      const [liveloxClasses, runnerLookups, classMap] = await Promise.all([
        fetchLiveloxEventClasses(input.liveloxEventId),
        buildRunnerLookups(client),
        buildClassNameMap(client),
      ]);

      let classesSynced = 0;
      let routesSynced = 0;
      const unmatchedRunners: string[] = [];
      const unmatchedClasses: string[] = [];

      // Process classes in batches of 5 to avoid overwhelming Livelox
      const BATCH = 5;
      for (let i = 0; i < liveloxClasses.classes.length; i += BATCH) {
        const batch = liveloxClasses.classes.slice(i, i + BATCH);
        await Promise.all(
          batch.map(async (cls) => {
            if (cls.participantCount === 0) return;
            try {
              const info = await fetchClassInfo(cls.id);
              const blob = await fetchClassBlob(info.classBlobUrl);
              const replayData = transformToReplayData(blob, {
                eventName: liveloxClasses.name,
                className: cls.name,
                tileProxyBase: "/api/livelox-tile",
              });

              const classId =
                classMap.get(cls.name.toLowerCase().trim()) ?? null;
              if (!classId) {
                unmatchedClasses.push(cls.name);
              }

              // Build participantId → matching metadata from raw blob
              const participantMeta = new Map<
                number,
                { personExtId: string | null; orgExtId: string | null; orgName: string | null; firstName: string; lastName: string }
              >();
              for (const p of blob.participants ?? []) {
                const personExtId =
                  p.person?.externalIdentifiers?.find((x) => x.system === 0)?.id ?? null;
                const orgExtId =
                  p.result?.organisationExternalIdentifier?.system === 0
                    ? (p.result.organisationExternalIdentifier.id ?? null)
                    : null;
                participantMeta.set(p.id, {
                  personExtId,
                  orgExtId,
                  orgName: p.result?.organisationName ?? null,
                  firstName: p.firstName,
                  lastName: p.lastName,
                });
              }

              // Delete existing routes for this Livelox class (clean re-sync)
              await client.$executeRawUnsafe(
                `DELETE FROM oxygen_routes WHERE LiveloxClassId = ?`,
                cls.id,
              );

              // Insert all routes for this class
              for (const route of replayData.routes) {
                const meta = participantMeta.get(Number(route.participantId));
                const firstName = meta?.firstName ?? route.name.trim().split(/\s+/)[0] ?? "";
                const lastName = meta?.lastName ?? route.name.trim().split(/\s+/).slice(1).join(" ");
                const runnerId = matchRunner(
                  firstName,
                  lastName,
                  meta?.personExtId ?? null,
                  meta?.orgExtId ?? null,
                  meta?.orgName ?? null,
                  runnerLookups,
                );

                if (!runnerId) {
                  unmatchedRunners.push(route.name);
                }

                await client.$executeRawUnsafe(
                  `INSERT INTO oxygen_routes
                   (RunnerId, ClassId, LiveloxClassId, SourceType, Color, RaceStartMs,
                    WaypointsJson, InterruptionsJson, ResultJson)
                   VALUES (?, ?, ?, 'livelox', ?, ?, ?, ?, ?)`,
                  runnerId,
                  classId,
                  cls.id,
                  route.color ?? "",
                  route.raceStartMs ?? null,
                  JSON.stringify(route.waypoints),
                  route.interruptions.length > 0
                    ? JSON.stringify(route.interruptions)
                    : null,
                  route.result ? JSON.stringify(route.result) : null,
                );
                routesSynced++;
              }
              classesSynced++;
            } catch {
              // Skip classes that fail (e.g., hidden, no route data)
            }
          }),
        );
      }

      return {
        classesSynced,
        routesSynced,
        unmatched: {
          runners: [...new Set(unmatchedRunners)],
          classes: [...new Set(unmatchedClasses)],
        },
      };
    }),

  /**
   * List synced routes with runner/class info joined from oRunner/oClass.
   * Unmatched routes (NULL RunnerId/ClassId) are included with empty name/class.
   */
  listRoutes: competitionProcedure
    .input(
      z.object({
        classId: z.number().int().positive().optional(),
        liveloxClassId: z.number().int().positive().optional(),
      }).optional(),
    )
    .query(async ({ ctx, input }) => {
      const client = ctx.db;
      await ensureRoutesTable(client, ctx.dbName);

      let where = "";
      const params: unknown[] = [];
      if (input?.classId) {
        where = "WHERE r.ClassId = ?";
        params.push(input.classId);
      } else if (input?.liveloxClassId) {
        where = "WHERE r.LiveloxClassId = ?";
        params.push(input.liveloxClassId);
      }

      const rows = await client.$queryRawUnsafe<
        Array<{
          Id: number;
          RunnerId: number | null;
          RunnerName: string | null;
          Organisation: string | null;
          ClassId: number | null;
          ClassName: string | null;
          LiveloxClassId: number | null;
          Color: string;
          RaceStartMs: bigint | null;
          ResultJson: string | null;
          SyncedAt: Date;
        }>
      >(
        `SELECT
           r.Id, r.RunnerId, ru.Name AS RunnerName,
           cl.Name AS Organisation,
           r.ClassId, oc.Name AS ClassName,
           r.LiveloxClassId, r.Color, r.RaceStartMs, r.ResultJson, r.SyncedAt
         FROM oxygen_routes r
         LEFT JOIN oRunner ru ON ru.Id = r.RunnerId
         LEFT JOIN oClub cl ON cl.Id = ru.Club
         LEFT JOIN oClass oc ON oc.Id = r.ClassId
         ${where}
         ORDER BY oc.Name, ru.Name`,
        ...params,
      );

      return rows.map((r) => ({
        id: r.Id,
        runnerId: r.RunnerId,
        runnerName: r.RunnerName ?? "",
        organisation: r.Organisation ?? "",
        classId: r.ClassId,
        className: r.ClassName ?? "",
        liveloxClassId: r.LiveloxClassId,
        color: r.Color,
        raceStartMs: r.RaceStartMs ? Number(r.RaceStartMs) : null,
        result: r.ResultJson
          ? (JSON.parse(r.ResultJson) as ReplayResult)
          : null,
        syncedAt: r.SyncedAt,
      }));
    }),

  /**
   * Return distinct synced class list with route counts.
   * Used for filter dropdowns and EventPage statistics.
   */
  listSyncedClasses: competitionProcedure.query(async ({ ctx }) => {
    const client = ctx.db;
    await ensureRoutesTable(client, ctx.dbName);

    const rows = await client.$queryRawUnsafe<
      Array<{
        ClassId: number | null;
        ClassName: string | null;
        LiveloxClassId: number | null;
        RouteCount: bigint;
        SyncedAt: Date;
      }>
    >(
      `SELECT r.ClassId, oc.Name AS ClassName, r.LiveloxClassId,
              COUNT(*) AS RouteCount, MAX(r.SyncedAt) AS SyncedAt
       FROM oxygen_routes r
       LEFT JOIN oClass oc ON oc.Id = r.ClassId
       WHERE r.SourceType = 'livelox'
       GROUP BY r.LiveloxClassId, r.ClassId, oc.Name
       ORDER BY oc.Name`,
    );

    return rows.map((r) => ({
      classId: r.ClassId,
      className: r.ClassName ?? `Livelox #${r.LiveloxClassId}`,
      liveloxClassId: r.LiveloxClassId,
      routeCount: Number(r.RouteCount),
      syncedAt: r.SyncedAt,
    }));
  }),

  /**
   * Delete a single route from oxygen_routes.
   */
  deleteRoute: competitionProcedure
    .input(z.object({ routeId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;
      await ensureRoutesTable(client, ctx.dbName);
      await client.$executeRawUnsafe(
        `DELETE FROM oxygen_routes WHERE Id = ?`,
        input.routeId,
      );
      return { ok: true };
    }),

  /**
   * Get waypoints + metadata for a single route — used by TrackMapPanel preview.
   * Does NOT re-fetch from Livelox; all data comes from the local DB.
   */
  getRoutePreview: competitionProcedure
    .input(z.object({ routeId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const client = ctx.db;
      await ensureRoutesTable(client, ctx.dbName);

      const rows = await client.$queryRawUnsafe<
        Array<{
          Id: number;
          Color: string;
          RaceStartMs: bigint | null;
          WaypointsJson: string;
          InterruptionsJson: string | null;
          ResultJson: string | null;
          LiveloxClassId: number | null;
          ClassId: number | null;
          RunnerName: string | null;
          CourseName: string | null;
        }>
      >(
        `SELECT r.Id, r.Color, r.RaceStartMs, r.WaypointsJson,
                r.InterruptionsJson, r.ResultJson, r.LiveloxClassId, r.ClassId,
                ru.Name AS RunnerName, co.Name AS CourseName
         FROM oxygen_routes r
         LEFT JOIN oRunner ru ON ru.Id = r.RunnerId
         LEFT JOIN oClass cl ON cl.Id = r.ClassId
         LEFT JOIN oCourse co ON co.Id = cl.Course
         WHERE r.Id = ?
         LIMIT 1`,
        input.routeId,
      );

      const row = rows[0];
      if (!row) throw new Error("Route not found");

      return {
        id: row.Id,
        color: row.Color,
        raceStartMs: row.RaceStartMs ? Number(row.RaceStartMs) : null,
        waypoints: JSON.parse(row.WaypointsJson) as ReplayWaypoint[],
        interruptions: row.InterruptionsJson
          ? (JSON.parse(row.InterruptionsJson) as number[])
          : [],
        result: row.ResultJson
          ? (JSON.parse(row.ResultJson) as ReplayResult)
          : null,
        liveloxClassId: row.LiveloxClassId,
        classId: row.ClassId,
        runnerName: row.RunnerName ?? "",
        courseName: row.CourseName ?? null,
      };
    }),
});
