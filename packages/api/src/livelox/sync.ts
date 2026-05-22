/**
 * Livelox sync — pulls GPS routes for every class in a Livelox event
 * and writes them into `oxygen.routes`.
 *
 * Per-class flow:
 *   fetchClassInfo → fetchClassBlob → transformToReplayData → match
 *   participants to local runners → DELETE then INSERT for that
 *   liveloxClassId (clean re-sync).
 *
 * Runner matching is 3-priority (Eventor person id → club-scoped name →
 * cross-club name) — same as the legacy pipeline, just re-pointed at the
 * new schema where clubs are derived from `runners.clubName /
 * eventorClubId` instead of a per-event `clubs` table.
 */

import { PrismaClient } from "@prisma/client";
import {
  fetchClassInfo,
  fetchClassBlob,
  fetchLiveloxEventClasses,
} from "./fetcher.js";
import { transformToReplayData } from "./transform.js";

export interface SyncResult {
  classesSynced: number;
  routesSynced: number;
  unmatched: { runners: string[]; classes: string[] };
}

/** Normalise a runner name for fuzzy matching. */
export function normName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface RunnerLookups {
  /** normName(fullName) → runner.id (cross-club fallback) */
  byFullName: Map<string, string>;
  /** eventorPersonId.toString() → runner.id (highest priority) */
  byEventorPersonId: Map<string, string>;
  /** eventorClubId → list of (runner.id, normName) for club-scoped matching */
  runnersByEventorClubId: Map<number, Array<{ id: string; norm: string }>>;
  /** normName(clubName) → list of runners that bear that clubName */
  runnersByClubName: Map<string, Array<{ id: string; norm: string }>>;
}

async function buildRunnerLookups(
  db: PrismaClient,
  eventId: bigint,
): Promise<RunnerLookups> {
  const runners = await db.runner.findMany({
    where: { eventId, removed: false },
    select: {
      id: true,
      name: true,
      clubName: true,
      eventorClubId: true,
      eventorPersonId: true,
    },
  });

  const byFullName = new Map<string, string>();
  const byEventorPersonId = new Map<string, string>();
  const runnersByEventorClubId = new Map<
    number,
    Array<{ id: string; norm: string }>
  >();
  const runnersByClubName = new Map<
    string,
    Array<{ id: string; norm: string }>
  >();

  for (const r of runners) {
    const norm = normName(r.name);
    byFullName.set(norm, r.id);
    if (r.eventorPersonId) {
      byEventorPersonId.set(r.eventorPersonId.toString(), r.id);
    }
    if (r.eventorClubId) {
      const cid = Number(r.eventorClubId);
      let list = runnersByEventorClubId.get(cid);
      if (!list) {
        list = [];
        runnersByEventorClubId.set(cid, list);
      }
      list.push({ id: r.id, norm });
    }
    if (r.clubName && r.clubName.length > 0) {
      const cn = normName(r.clubName);
      let list = runnersByClubName.get(cn);
      if (!list) {
        list = [];
        runnersByClubName.set(cn, list);
      }
      list.push({ id: r.id, norm });
    }
  }

  return { byFullName, byEventorPersonId, runnersByEventorClubId, runnersByClubName };
}

async function buildClassNameMap(
  db: PrismaClient,
  eventId: bigint,
): Promise<Map<string, string>> {
  const classes = await db.class.findMany({
    where: { eventId, removed: false },
    select: { id: true, name: true },
  });
  const map = new Map<string, string>();
  for (const c of classes) {
    map.set(c.name.toLowerCase().trim(), c.id);
  }
  return map;
}

/**
 * 3-priority runner match. Mirrors the legacy logic but operates on the
 * new `runners` schema (UUID ids, derived club data).
 */
export function matchRunner(
  firstName: string,
  lastName: string,
  personExtId: string | null,
  orgExtId: string | null,
  orgName: string | null,
  lookups: RunnerLookups,
): string | null {
  // P1: Eventor person id.
  if (personExtId) {
    const id = lookups.byEventorPersonId.get(personExtId);
    if (id) return id;
  }

  const tryClubMatch = (
    candidates: Array<{ id: string; norm: string }>,
  ): string | null => {
    const fl = normName(`${firstName} ${lastName}`);
    const lf = normName(`${lastName} ${firstName}`);
    for (const r of candidates) {
      if (r.norm === fl || r.norm === lf) return r.id;
    }
    // Middle-name strip retry.
    const first1 = firstName.trim().split(/\s+/)[0] ?? "";
    if (first1 && first1 !== firstName.trim()) {
      const fl2 = normName(`${first1} ${lastName}`);
      const lf2 = normName(`${lastName} ${first1}`);
      for (const r of candidates) {
        if (r.norm === fl2 || r.norm === lf2) return r.id;
      }
    }
    return null;
  };

  // P2a: Eventor club id-scoped name match.
  if (orgExtId) {
    const cid = parseInt(orgExtId, 10);
    if (Number.isFinite(cid)) {
      const candidates = lookups.runnersByEventorClubId.get(cid) ?? [];
      const id = tryClubMatch(candidates);
      if (id) return id;
    }
  }

  // P2b: Club name-scoped name match.
  if (orgName) {
    const candidates = lookups.runnersByClubName.get(normName(orgName)) ?? [];
    const id = tryClubMatch(candidates);
    if (id) return id;
  }

  // P3: Cross-club exact name match.
  const fl = normName(`${firstName} ${lastName}`);
  const lf = normName(`${lastName} ${firstName}`);
  const exact = lookups.byFullName.get(fl) ?? lookups.byFullName.get(lf);
  if (exact) return exact;

  // P3b: Cross-club middle-name strip.
  const first1 = firstName.trim().split(/\s+/)[0] ?? "";
  if (first1 && first1 !== firstName.trim()) {
    const fl2 = normName(`${first1} ${lastName}`);
    const lf2 = normName(`${lastName} ${first1}`);
    return lookups.byFullName.get(fl2) ?? lookups.byFullName.get(lf2) ?? null;
  }

  return null;
}

/** Process up to N classes in parallel to avoid hammering Livelox. */
const BATCH = 5;

export async function syncEvent(
  db: PrismaClient,
  eventId: bigint,
  liveloxEventId: number,
): Promise<SyncResult> {
  const [liveloxClasses, runnerLookups, classMap] = await Promise.all([
    fetchLiveloxEventClasses(liveloxEventId),
    buildRunnerLookups(db, eventId),
    buildClassNameMap(db, eventId),
  ]);

  let classesSynced = 0;
  let routesSynced = 0;
  const unmatchedRunners: string[] = [];
  const unmatchedClasses: string[] = [];

  for (let i = 0; i < liveloxClasses.classes.length; i += BATCH) {
    const batch = liveloxClasses.classes.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (cls) => {
        if (cls.participantCount === 0) return;
        try {
          const info = await fetchClassInfo(cls.id);
          const blob = await fetchClassBlob(info.classBlobUrl);
          const replay = transformToReplayData(blob, {
            eventName: liveloxClasses.name,
            className: cls.name,
            tileProxyBase: "/api/livelox-tile",
          });

          const classId =
            classMap.get(cls.name.toLowerCase().trim()) ?? null;
          if (!classId) unmatchedClasses.push(cls.name);

          // Build participantId → matching metadata for runner matching.
          const participantMeta = new Map<
            number,
            {
              personExtId: string | null;
              orgExtId: string | null;
              orgName: string | null;
              firstName: string;
              lastName: string;
            }
          >();
          for (const p of blob.participants ?? []) {
            const personExtId =
              p.person?.externalIdentifiers?.find((x) => x.system === 0)?.id ??
              null;
            const orgExtId =
              p.result?.organisationExternalIdentifier?.system === 0
                ? p.result.organisationExternalIdentifier.id ?? null
                : null;
            participantMeta.set(p.id, {
              personExtId,
              orgExtId,
              orgName: p.result?.organisationName ?? null,
              firstName: p.firstName,
              lastName: p.lastName,
            });
          }

          // Clean re-sync per liveloxClassId.
          await db.route.deleteMany({
            where: { eventId, liveloxClassId: cls.id },
          });

          for (const route of replay.routes) {
            const meta = participantMeta.get(Number(route.participantId));
            const firstName =
              meta?.firstName ??
              route.name.trim().split(/\s+/)[0] ??
              "";
            const lastName =
              meta?.lastName ??
              route.name.trim().split(/\s+/).slice(1).join(" ");
            const runnerId = matchRunner(
              firstName,
              lastName,
              meta?.personExtId ?? null,
              meta?.orgExtId ?? null,
              meta?.orgName ?? null,
              runnerLookups,
            );
            if (!runnerId) unmatchedRunners.push(route.name);

            await db.route.create({
              data: {
                eventId,
                runnerId,
                classId,
                liveloxClassId: cls.id,
                sourceType: "livelox",
                color: route.color ?? "",
                raceStartMs:
                  route.raceStartMs !== null && route.raceStartMs !== undefined
                    ? BigInt(route.raceStartMs)
                    : null,
                waypoints: route.waypoints as never,
                interruptions:
                  route.interruptions.length > 0
                    ? (route.interruptions as never)
                    : undefined,
                result: route.result ? (route.result as never) : undefined,
              },
            });
            routesSynced++;
          }
          classesSynced++;
        } catch (err) {
          // One bad class shouldn't kill the whole sync — log it and
          // continue with the rest.
          console.error(
            `[livelox] sync failed for class ${cls.id} (${cls.name}):`,
            err,
          );
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
}
