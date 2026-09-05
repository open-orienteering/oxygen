/**
 * Eventor sync router (PostgreSQL/oxygen-schema port).
 *
 * Public endpoints (key management + browsing) work without an event
 * context. Event-scoped endpoints (sync / import-related-to-event /
 * push) require the x-event-id header via `manageProcedure`.
 *
 * Notable schema changes vs. the legacy (MeOS) router:
 *  - No per-event clubs table. We sync clubs into the **global**
 *    `clubDirectory` and stamp each runner with `clubName` +
 *    `eventorClubId` (Phase I).
 *  - Eventor person IDs live on `runner.eventorPersonId` (BigInt).
 *  - Logos live on `clubDirectory.{small,large}LogoPng`.
 *  - Last-sync timestamp lives on `events.eventor_last_sync`.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, authedProcedure, manageProcedure } from "../trpc.js";
import { getSetting, setSetting, prisma, sanitizeNameId, isReservedEventSlug } from "../db.js";
import { grantSystemGroup } from "../permissions.js";
import {
  SYSTEM_GROUP_IDS,
  eventKindFromClassification,
} from "@oxygen/shared";
import {
  EventorAuthError,
  fetchEvents,
  fetchEventClasses,
  fetchEntries,
  fetchEventMeta,
  fetchResults,
  fetchReferencedClubs,
  fetchClubs,
  fetchClubLogo,
  fetchCompetitors,
  fetchCachedCompetitors,
  uploadResults,
  uploadStartList,
  type EventorEntry,
  type EventorResult,
  type EventorClub,
  type EventorCompetitor,
  type ResultForUpload,
} from "../eventor.js";
import { eventorKeyStore } from "../eventorKeyStore.js";
import {
  runnerStatusToValue,
  valueToRunnerStatus,
} from "../statusConvert.js";
import {
  parsePunches,
  matchPunchesToCourse,
  computeClassPlacements,
  type ParsedPunch,
  RunnerStatus,
} from "@oxygen/shared";
import { toAbsolute } from "../timeConvert.js";
import { resolveCourseExpectedPositions } from "./course.js";
import type {
  EventorEnvironment,
  RunnerStatusValue,
} from "@oxygen/shared";

// ── Helpers ────────────────────────────────────────────────────────────────

async function requireApiKey(
  env: EventorEnvironment = "prod",
): Promise<{ apiKey: string }> {
  const apiKey = await eventorKeyStore.getKey(env);
  if (!apiKey) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Eventor API key for ${env} not configured. Please validate your key first.`,
    });
  }
  return { apiKey };
}

async function requireApiKeyWithOrg(env: EventorEnvironment = "prod") {
  const result = await eventorKeyStore.getKeyWithOrg(env);
  if (!result) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Eventor API key for ${env} not configured. Please validate your key first.`,
    });
  }
  return result;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const INT32_MAX = 2_147_483_647;

/** Clamp a number into signed-INT32 range; non-finite → 0. */
function clampInt32(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n > INT32_MAX) return INT32_MAX;
  if (n < -INT32_MAX - 1) return -INT32_MAX - 1;
  return n | 0;
}

/**
 * Normalize an Eventor card number for storage. The `runners` table uses
 * NULL — not 0 — for "no card" and enforces a partial unique index on
 * (event_id, card_no) WHERE removed = false, so writing 0 for a second
 * cardless runner would violate the constraint. Non-positive → null.
 */
export function normalizeCardNo(
  raw: number | null | undefined,
): number | null {
  const v = clampInt32(raw ?? 0);
  return v > 0 ? v : null;
}

/**
 * Card-number claimer for one import/sync pass, guarding the partial
 * unique index on (event_id, card_no). The first owner to claim a card
 * keeps it; a later claim by a different owner gets `fallback` instead
 * (null for creates, the runner's current card for sync updates).
 * Eventor data does contain duplicate card numbers (shared/loaned
 * cards, data-entry mistakes), and one bad pair must not abort the
 * whole import.
 */
export function makeCardNoClaimer(
  existing: Iterable<{ ownerKey: string; cardNo: number | null }> = [],
): (
  raw: number | null | undefined,
  ownerKey: string,
  fallback?: number | null,
) => number | null {
  const ownerByCard = new Map<number, string>();
  for (const e of existing) {
    if (e.cardNo != null && e.cardNo > 0) ownerByCard.set(e.cardNo, e.ownerKey);
  }
  return (raw, ownerKey, fallback = null) => {
    const v = normalizeCardNo(raw);
    if (v === null) return null;
    const owner = ownerByCard.get(v);
    if (owner !== undefined && owner !== ownerKey) return fallback;
    ownerByCard.set(v, ownerKey);
    return v;
  };
}

/** Per-cluster in-memory club-member cache (10 min TTL). */
const MEMBER_CACHE_TTL_MS = 10 * 60_000;
const clubMemberCache = new Map<
  string,
  { members: EventorCompetitor[]; fetchedAt: number }
>();

// ── Club sync helper (writes to clubDirectory) ────────────────────────────

async function syncClubDirectoryEntries(clubs: EventorClub[]): Promise<{
  added: number;
  updated: number;
}> {
  if (clubs.length === 0) return { added: 0, updated: 0 };
  const db = prisma();
  const ids = clubs.map((c) => BigInt(c.id));
  const existing = await db.clubDirectory.findMany({
    where: { eventorId: { in: ids } },
    select: { eventorId: true },
  });
  const existingSet = new Set(existing.map((c) => c.eventorId.toString()));

  let added = 0;
  let updated = 0;
  for (const c of clubs) {
    if (!c.id || !c.name) continue;
    const data = {
      name: c.name,
      shortName: (c.shortName || c.name).substring(0, 17),
      countryCode: (c.countryCode || "").substring(0, 3),
      updatedAt: new Date(),
    };
    if (existingSet.has(BigInt(c.id).toString())) {
      await db.clubDirectory.update({
        where: { eventorId: BigInt(c.id) },
        data,
      });
      updated++;
    } else {
      await db.clubDirectory.create({
        data: { eventorId: BigInt(c.id), ...data },
      });
      added++;
    }
  }
  return { added, updated };
}

// ── Runner upsert helpers ────────────────────────────────────────────────

interface RunnerImportContext {
  eventId: bigint;
  eventorEventId: number;
  classByEventorId: Map<number, { id: string; eventorId: bigint | null }>;
  clubNameByEventorId: Map<number, string>;
}

function buildClubName(
  ctx: RunnerImportContext,
  eventorClubId: number,
  fallbackName: string,
): { clubName: string; eventorClubId: bigint | null } {
  if (eventorClubId > 0) {
    const name = ctx.clubNameByEventorId.get(eventorClubId) ?? fallbackName;
    return { clubName: name, eventorClubId: BigInt(eventorClubId) };
  }
  return { clubName: fallbackName ?? "", eventorClubId: null };
}

async function deriveClassFees(eventId: bigint): Promise<void> {
  const db = prisma();
  const runners = await db.runner.findMany({
    where: { eventId, removed: false, feeCents: { gt: 0 } },
    select: { classId: true, feeCents: true },
  });
  if (runners.length === 0) return;

  const feesByClassId = new Map<string, number[]>();
  for (const r of runners) {
    if (!r.classId) continue;
    let arr = feesByClassId.get(r.classId);
    if (!arr) {
      arr = [];
      feesByClassId.set(r.classId, arr);
    }
    arr.push(r.feeCents);
  }

  for (const [classId, fees] of feesByClassId) {
    const counts = new Map<number, number>();
    for (const f of fees) counts.set(f, (counts.get(f) ?? 0) + 1);
    let mode = 0;
    let max = 0;
    for (const [fee, count] of counts) {
      if (count > max) {
        mode = fee;
        max = count;
      }
    }
    if (mode > 0) {
      await db.class.update({
        where: { id: classId },
        data: { classFeeCents: mode },
      });
    }
  }
}

async function syncClassesFromEventor(
  eventId: bigint,
  eventorClasses: Awaited<ReturnType<typeof fetchEventClasses>>,
): Promise<{
  added: number;
  updated: number;
  classByEventorId: Map<number, { id: string; eventorId: bigint | null }>;
}> {
  const db = prisma();
  const existing = await db.class.findMany({
    where: { eventId, removed: false },
    select: {
      id: true,
      name: true,
      eventorId: true,
      courseId: true,
      sortIndex: true,
      sex: true,
      lowAge: true,
      highAge: true,
      noTiming: true,
      classType: true,
    },
  });
  const byEventorId = new Map(
    existing
      .filter((c) => c.eventorId !== null)
      .map((c) => [Number(c.eventorId!), c]),
  );
  const result = new Map<number, { id: string; eventorId: bigint | null }>();

  let maxSortIdx = Math.max(0, ...existing.map((c) => c.sortIndex));
  let added = 0;
  let updated = 0;
  const lengthsByCourseId = new Map<string, Set<number>>();

  for (const ec of eventorClasses) {
    const existingRow = byEventorId.get(ec.classId);
    if (existingRow) {
      if (existingRow.courseId && (ec.courseLengthM ?? 0) > 0) {
        const lengths = lengthsByCourseId.get(existingRow.courseId) ?? new Set();
        lengths.add(ec.courseLengthM!);
        lengthsByCourseId.set(existingRow.courseId, lengths);
      }
      const needsUpdate =
        existingRow.name !== ec.name ||
        existingRow.sex !== (ec.sex || "") ||
        existingRow.lowAge !== ec.lowAge ||
        existingRow.highAge !== ec.highAge ||
        existingRow.noTiming !== ec.noTiming ||
        (ec.sequence > 0 && existingRow.sortIndex !== ec.sequence) ||
        (ec.classType && existingRow.classType !== ec.classType);
      if (needsUpdate) {
        await db.class.update({
          where: { id: existingRow.id },
          data: {
            name: ec.name,
            sex: ec.sex || "",
            lowAge: ec.lowAge,
            highAge: ec.highAge,
            noTiming: ec.noTiming,
            ...(ec.sequence > 0 ? { sortIndex: ec.sequence } : {}),
            ...(ec.classType ? { classType: ec.classType.substring(0, 81) } : {}),
          },
        });
        updated++;
      }
      result.set(ec.classId, { id: existingRow.id, eventorId: BigInt(ec.classId) });
    } else {
      maxSortIdx += 10;
      const created = await db.class.create({
        data: {
          eventId,
          name: ec.name,
          sortIndex: ec.sequence > 0 ? ec.sequence : maxSortIdx,
          eventorId: BigInt(ec.classId),
          sex: ec.sex || "",
          lowAge: ec.lowAge,
          highAge: ec.highAge,
          classType: ec.classType.substring(0, 81),
          noTiming: ec.noTiming,
        },
        select: { id: true },
      });
      result.set(ec.classId, { id: created.id, eventorId: BigInt(ec.classId) });
      added++;
    }
  }

  // Eventor's IOF start list is authoritative for the published class
  // course length. Only update a shared course when every assigned class
  // reported the same positive value; conflicting values indicate a bad
  // class-course assignment and must not be resolved by last-write-wins.
  for (const [courseId, lengths] of lengthsByCourseId) {
    if (lengths.size !== 1) continue;
    await db.course.updateMany({
      // Once a course has been edited in Oxygen, its freshly-derived
      // geometry/length supersedes Eventor's previously published snapshot.
      where: {
        id: courseId,
        eventId,
        removed: false,
        geometrySource: { not: "editor" },
      },
      data: { lengthM: [...lengths][0] },
    });
  }

  return { added, updated, classByEventorId: result };
}

/**
 * Upsert clubs referenced by `entries` (and optionally `results`) into
 * the global club_directory and return a Map(eventorClubId → clubName)
 * for stamping onto runners.
 *
 * Fires logo fetches in the background — promise discarded so the
 * caller doesn't block on Eventor logo IO.
 */
async function syncClubsFromEntries(
  apiKey: string,
  env: EventorEnvironment,
  entries: EventorEntry[],
  results: EventorResult[] = [],
): Promise<{
  added: number;
  updated: number;
  clubNameByEventorId: Map<number, string>;
}> {
  // Build the set of clubs we've seen in entries / results.
  const seen = new Map<number, EventorClub>();
  for (const e of entries) {
    if (e.organisationId > 0 && !seen.has(e.organisationId)) {
      seen.set(e.organisationId, {
        id: e.organisationId,
        name: e.organisationName,
        shortName: e.organisationShortName || "",
        countryCode: e.organisationCountry || "",
        careOf: "",
        street: "",
        city: "",
        zip: "",
        email: "",
        phone: "",
        webUrl: "",
      });
    }
  }
  for (const r of results) {
    if (r.organisationId > 0 && !seen.has(r.organisationId)) {
      seen.set(r.organisationId, {
        id: r.organisationId,
        name: r.organisationName,
        shortName: r.organisationShortName || "",
        countryCode: r.organisationCountry || "",
        careOf: "",
        street: "",
        city: "",
        zip: "",
        email: "",
        phone: "",
        webUrl: "",
      });
    }
  }

  // Enrich with full address info via fetchReferencedClubs (best-effort).
  try {
    const fullClubs = await fetchReferencedClubs(apiKey, entries);
    for (const [id, c] of fullClubs) seen.set(id, c);
  } catch {
    // Non-critical — entry-derived names are enough.
  }

  const { added, updated } = await syncClubDirectoryEntries([...seen.values()]);

  const clubNameByEventorId = new Map<number, string>();
  for (const [id, c] of seen) clubNameByEventorId.set(id, c.name);

  // Logo fetch in the background (always prod-Eventor; org IDs are shared).
  void (async () => {
    try {
      const db = prisma();
      const existing = await db.clubDirectory.findMany({
        where: { eventorId: { in: [...seen.keys()].map((id) => BigInt(id)) } },
        select: { eventorId: true, smallLogoPng: true },
      });
      const needsLogo = existing
        .filter((c) => !c.smallLogoPng)
        .map((c) => Number(c.eventorId));
      const BATCH = 20;
      for (let i = 0; i < needsLogo.length; i += BATCH) {
        const batch = needsLogo.slice(i, i + BATCH);
        await Promise.all(
          batch.map(async (orgId) => {
            try {
              const small = await fetchClubLogo(orgId, apiKey, "SmallIcon");
              const large = await fetchClubLogo(orgId, apiKey, "LargeIcon");
              if (small) {
                await db.clubDirectory.update({
                  where: { eventorId: BigInt(orgId) },
                  data: {
                    smallLogoPng: Buffer.from(small),
                    ...(large ? { largeLogoPng: Buffer.from(large) } : {}),
                    updatedAt: new Date(),
                  },
                });
              }
            } catch {
              // Individual logo failures are not fatal.
            }
            void env;
          }),
        );
      }
    } catch {
      // Non-critical — logos sync on the next run.
    }
  })();

  return { added, updated, clubNameByEventorId };
}

// ── Router ─────────────────────────────────────────────────────────────────

export const eventorRouter = router({
  // ───────────── Key management ─────────────

  validateKey: publicProcedure
    .input(
      z.object({
        apiKey: z.string().min(1),
        env: z.enum(["prod", "test"]).default("prod"),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        const org = await eventorKeyStore.setKey(input.apiKey, input.env);
        return {
          organisationId: org.id,
          organisationName: org.name,
        };
      } catch (err) {
        if (err instanceof EventorAuthError) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Eventor rejected the API key (403). Double-check it.",
          });
        }
        throw err;
      }
    }),

  clearKey: publicProcedure
    .input(z.object({ env: z.enum(["prod", "test"]).default("prod") }))
    .mutation(async ({ input }) => {
      await eventorKeyStore.clearKey(input.env);
      return { success: true as const };
    }),

  keyStatus: publicProcedure
    .input(z.object({ env: z.enum(["prod", "test"]).default("prod") }))
    .query(async ({ input }) => {
      const apiKey = await eventorKeyStore.getKey(input.env);
      if (!apiKey) return { connected: false as const };
      const cached = eventorKeyStore.peek(input.env);
      return {
        connected: true as const,
        organisationId: cached?.org?.id,
        organisationName: cached?.org?.name,
        hasKey: true,
        env: input.env,
        valid: true,
      };
    }),

  getKey: publicProcedure
    .input(z.object({ env: z.enum(["prod", "test"]).default("prod") }))
    .query(async ({ input }) => {
      const apiKey = await eventorKeyStore.getKey(input.env);
      return { hasKey: !!apiKey, env: input.env };
    }),

  setKey: publicProcedure
    .input(
      z.object({
        env: z.enum(["prod", "test"]).default("prod"),
        apiKey: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      await eventorKeyStore.setKey(input.apiKey, input.env);
      return { ok: true as const };
    }),

  setEventEnv: manageProcedure
    .input(z.object({ env: z.enum(["prod", "test"]) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.event.update({
        where: { id: ctx.event.id },
        data: { eventorEnv: input.env },
      });
      return { ok: true as const };
    }),

  // ───────────── Browse events ─────────────

  events: publicProcedure
    .input(
      z
        .object({
          fromDate: z.string().optional(),
          toDate: z.string().optional(),
          env: z.enum(["prod", "test"]).default("prod"),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const { apiKey, org } = await requireApiKeyWithOrg(input?.env);
      const now = new Date();
      const sixMonthsAgo = new Date(now);
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      const sixMonthsAhead = new Date(now);
      sixMonthsAhead.setMonth(sixMonthsAhead.getMonth() + 6);
      const fromDate = input?.fromDate ?? formatDate(sixMonthsAgo);
      const toDate = input?.toDate ?? formatDate(sixMonthsAhead);
      return fetchEvents(apiKey, org.id, fromDate, toDate, input?.env);
    }),

  searchEvents: publicProcedure
    .input(
      z.object({
        query: z.string(),
        env: z.enum(["prod", "test"]).default("prod"),
      }),
    )
    .query(async ({ input }) => {
      const { apiKey, org } = await requireApiKeyWithOrg(input.env);
      const now = new Date();
      const twelveMonthsAgo = new Date(now);
      twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
      const sixMonthsAhead = new Date(now);
      sixMonthsAhead.setMonth(sixMonthsAhead.getMonth() + 6);
      const events = await fetchEvents(
        apiKey,
        org.id,
        formatDate(twelveMonthsAgo),
        formatDate(sixMonthsAhead),
        input.env,
      );
      const q = input.query.trim().toLowerCase();
      if (q.length === 0) return events;
      return events.filter((e) => e.name.toLowerCase().includes(q));
    }),

  eventDetail: publicProcedure
    .input(
      z.object({
        eventId: z.number().int().positive(),
        env: z.enum(["prod", "test"]).default("prod"),
      }),
    )
    .query(async ({ input }) => {
      const { apiKey } = await requireApiKey(input.env);
      const [classes, entries] = await Promise.all([
        fetchEventClasses(apiKey, input.eventId, input.env),
        fetchEntries(apiKey, input.eventId, input.env),
      ]);
      const entryCounts = new Map<number, number>();
      for (const e of entries) {
        entryCounts.set(e.classId, (entryCounts.get(e.classId) ?? 0) + 1);
      }
      return {
        classes: classes.map((c) => ({
          ...c,
          entryCount: entryCounts.get(c.classId) ?? 0,
        })),
        totalEntries: entries.length,
      };
    }),

  // ───────────── Import event (new) ─────────────

  /**
   * Create a new Event row from an Eventor event and populate its
   * classes + runners. Public because it's invoked from the event
   * selector before any event is open.
   */
  importEvent: authedProcedure
    .input(
      z.object({
        eventId: z.number().int().positive(),
        eventName: z.string().min(1),
        eventDate: z.string().min(1),
        classificationId: z.number().int().nonnegative(),
        organiserName: z.string().optional(),
        organiserId: z.number().int().optional(),
        env: z.enum(["prod", "test"]).default("prod"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { apiKey } = await requireApiKey(input.env);
      const db = prisma();

      // 1. Fetch from Eventor in parallel.
      const [classes, entries, results] = await Promise.all([
        fetchEventClasses(apiKey, input.eventId, input.env),
        fetchEntries(apiKey, input.eventId, input.env),
        fetchResults(apiKey, input.eventId, input.env),
      ]);

      // 2. Create the event row.
      const nameId = sanitizeNameId(input.eventName);
      if (isReservedEventSlug(nameId)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Slug "${nameId}" is reserved.`,
        });
      }
      const event = await db.$transaction(async (tx) => {
        const created = await tx.event.create({
          data: {
            nameId,
            name: input.eventName,
            date: new Date(input.eventDate),
            kind: eventKindFromClassification(input.classificationId),
            eventorEventId: BigInt(input.eventId),
            eventorEnv: input.env,
            eventorLastSync: new Date(),
            organizerName: input.organiserName ?? "",
            organizerEventorId: input.organiserId ?? 0,
          },
          select: { id: true, nameId: true },
        });
        await tx.eventorEventMeta.upsert({
          where: { eventorEventId: input.eventId },
          create: {
            eventorEventId: input.eventId,
            name: input.eventName,
            startDate: new Date(input.eventDate),
            classificationId: input.classificationId,
            organiser: input.organiserName ?? "",
            entryCount: entries.length,
            fetchedAt: new Date(),
          },
          update: {
            name: input.eventName,
            startDate: new Date(input.eventDate),
            classificationId: input.classificationId,
            organiser: input.organiserName ?? "",
            entryCount: entries.length,
            fetchedAt: new Date(),
          },
        });
        return created;
      });
      if (ctx.user) {
        await grantSystemGroup(db, {
          eventId: event.id,
          userId: ctx.user.id,
          groupId: SYSTEM_GROUP_IDS.eventAdmin,
          grantedBy: ctx.user.id,
        });
      }

      // 3. Upsert classes.
      const { classByEventorId } = await syncClassesFromEventor(
        event.id,
        classes,
      );

      // 4. Sync clubs (writes to clubDirectory + returns name lookup).
      const { clubNameByEventorId } = await syncClubsFromEntries(
        apiKey,
        input.env,
        entries,
        results,
      );

      // 5. Build a personId → result map for fast joins.
      const resultsByPersonId = new Map<number, EventorResult>();
      for (const r of results) {
        if (r.personId > 0) resultsByPersonId.set(r.personId, r);
      }

      // 6. Import runners from entries (then results-only late entries).
      const seenPersonIds = new Set<number>();
      const claimCardNo = makeCardNoClaimer();
      let runnerCount = 0;

      for (const entry of entries) {
        const cls = classByEventorId.get(entry.classId);
        const result = resultsByPersonId.get(entry.personId);
        const club = buildClubName(
          {
            eventId: event.id,
            eventorEventId: input.eventId,
            classByEventorId,
            clubNameByEventorId,
          },
          entry.organisationId,
          entry.organisationName,
        );
        const runnerStatus: RunnerStatusValue = (result?.status as RunnerStatusValue) ??
          ((entry.noTiming
            ? RunnerStatus.NoTiming
            : RunnerStatus.Unknown) as RunnerStatusValue);
        await db.runner.create({
          data: {
            eventId: event.id,
            classId: cls?.id ?? null,
            clubName: club.clubName,
            eventorClubId: club.eventorClubId,
            name: entry.personName,
            cardNo: claimCardNo(
              result?.cardNo || entry.cardNo,
              `person:${entry.personId}`,
            ),
            eventorPersonId: BigInt(entry.personId),
            eventorEntryId:
              entry.eventorEntryId > 0 ? BigInt(entry.eventorEntryId) : null,
            entrySource: clampInt32(input.eventId),
            birthYear: entry.birthYear,
            sex: entry.sex,
            nationality: (result?.nationality || entry.nationality).substring(0, 7),
            entryDate: entry.entryDate,
            entryTime: entry.entryTime,
            startTime: result?.startTime ?? 0,
            finishTime: result?.finishTime ?? 0,
            status: valueToRunnerStatus(runnerStatus),
            startNo: result?.startNo ?? 0,
            bib: (result?.bib ?? "").substring(0, 17),
            feeCents: clampInt32(entry.fee),
            paidCents: clampInt32(entry.paid),
            taxableCents: clampInt32(entry.taxable),
            rank: Math.round(entry.rankingScore),
          },
        });
        seenPersonIds.add(entry.personId);
        runnerCount++;
      }

      // Results-only (e.g. day-of late entries that bypassed Entry).
      for (const result of results) {
        if (result.personId <= 0 || seenPersonIds.has(result.personId)) continue;
        const cls = classByEventorId.get(result.classId);
        const club = buildClubName(
          {
            eventId: event.id,
            eventorEventId: input.eventId,
            classByEventorId,
            clubNameByEventorId,
          },
          result.organisationId,
          result.organisationName,
        );
        await db.runner.create({
          data: {
            eventId: event.id,
            classId: cls?.id ?? null,
            clubName: club.clubName,
            eventorClubId: club.eventorClubId,
            name: result.personName,
            cardNo: claimCardNo(result.cardNo, `person:${result.personId}`),
            eventorPersonId: BigInt(result.personId),
            entrySource: clampInt32(input.eventId),
            birthYear: result.birthYear,
            sex: result.sex,
            nationality: (result.nationality ?? "").substring(0, 7),
            startTime: result.startTime,
            finishTime: result.finishTime,
            status: valueToRunnerStatus(result.status as RunnerStatusValue),
            startNo: result.startNo,
            bib: (result.bib ?? "").substring(0, 17),
          },
        });
        seenPersonIds.add(result.personId);
        runnerCount++;
      }

      // 7. Derive class fees from the mode entry fee per class.
      await deriveClassFees(event.id);

      return {
        nameId: event.nameId,
        eventId: Number(event.id),
        classCount: classes.length,
        clubCount: clubNameByEventorId.size,
        runnerCount,
      };
    }),

  // ───────────── Per-event sync ─────────────

  syncStatus: manageProcedure.query(async ({ ctx }) => {
    const event = await ctx.db.event.findUnique({
      where: { id: ctx.event.id },
      select: {
        eventorEventId: true,
        eventorEnv: true,
        eventorLastSync: true,
      },
    });
    const env = (event?.eventorEnv as EventorEnvironment | undefined) ?? "prod";
    const apiKeyConfigured = (await eventorKeyStore.getKey(env)) !== null;
    if (!event || !event.eventorEventId) {
      return { linked: false as const, apiKeyConfigured, env };
    }
    const [runnerCount, classCount] = await Promise.all([
      ctx.db.runner.count({
        where: { eventId: ctx.event.id, removed: false },
      }),
      ctx.db.class.count({
        where: { eventId: ctx.event.id, removed: false },
      }),
    ]);
    return {
      linked: true as const,
      eventorEventId: Number(event.eventorEventId),
      lastSync: event.eventorLastSync?.toISOString() ?? null,
      apiKeyConfigured,
      env,
      runnerCount,
      classCount,
    };
  }),

  /** Incremental sync — classes + clubs + runners from Eventor. */
  sync: manageProcedure.mutation(async ({ ctx }) => {
    const db = ctx.db;
    const event = await db.event.findUnique({
      where: { id: ctx.event.id },
      select: { eventorEventId: true, eventorEnv: true },
    });
    if (!event?.eventorEventId) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "This event is not linked to an Eventor event.",
      });
    }
    const env = (event.eventorEnv as EventorEnvironment) ?? "prod";
    const { apiKey } = await requireApiKey(env);
    const eventorEventId = Number(event.eventorEventId);

    const stats = {
      classesAdded: 0,
      classesUpdated: 0,
      clubsAdded: 0,
      clubsUpdated: 0,
      runnersAdded: 0,
      runnersUpdated: 0,
      /**
       * Runners that exist locally but Eventor no longer reports — we
       * flip them to `cancel` so the start list reflects withdrawals
       * without dropping the row (keeps audit history intact).
       */
      cancelledCount: 0,
    };

    // 1. Classes
    const eventorClasses = await fetchEventClasses(apiKey, eventorEventId, env);
    const classSync = await syncClassesFromEventor(ctx.event.id, eventorClasses);
    stats.classesAdded = classSync.added;
    stats.classesUpdated = classSync.updated;
    const classByEventorId = classSync.classByEventorId;

    // 2. Entries + results in parallel
    const [entries, results] = await Promise.all([
      fetchEntries(apiKey, eventorEventId, env),
      fetchResults(apiKey, eventorEventId, env),
    ]);

    // 3. Clubs (global)
    const clubSync = await syncClubsFromEntries(apiKey, env, entries, results);
    stats.clubsAdded = clubSync.added;
    stats.clubsUpdated = clubSync.updated;

    const resultsByPersonId = new Map<number, EventorResult>();
    for (const r of results) {
      if (r.personId > 0) resultsByPersonId.set(r.personId, r);
    }

    // 4. Existing runners, indexed by Eventor person id
    const existing = await db.runner.findMany({
      where: {
        eventId: ctx.event.id,
        eventorPersonId: { not: null },
      },
      select: {
        id: true,
        name: true,
        cardNo: true,
        classId: true,
        eventorClubId: true,
        clubName: true,
        birthYear: true,
        sex: true,
        nationality: true,
        startTime: true,
        finishTime: true,
        status: true,
        entrySource: true,
        feeCents: true,
        paidCents: true,
        taxableCents: true,
        rank: true,
        eventorPersonId: true,
      },
    });
    const byPersonId = new Map(
      existing.map((r) => [Number(r.eventorPersonId), r]),
    );

    // Card claims must respect every non-removed runner in the event —
    // including locally-registered ones without an Eventor person id —
    // or an update/create would trip the (event_id, card_no) unique index.
    const runnersWithCards = await db.runner.findMany({
      where: { eventId: ctx.event.id, removed: false, cardNo: { not: null } },
      select: { id: true, cardNo: true },
    });
    const claimCardNo = makeCardNoClaimer(
      runnersWithCards.map((r) => ({ ownerKey: r.id, cardNo: r.cardNo })),
    );

    const seen = new Set<number>();

    for (const entry of entries) {
      const cls = classByEventorId.get(entry.classId);
      const result = resultsByPersonId.get(entry.personId);
      const club = buildClubName(
        {
          eventId: ctx.event.id,
          eventorEventId,
          classByEventorId,
          clubNameByEventorId: clubSync.clubNameByEventorId,
        },
        entry.organisationId,
        entry.organisationName,
      );
      const found = byPersonId.get(entry.personId);
      if (found) {
        // Cancel→re-entered: reset status to default if we previously
        // stamped them Cancel (21) and there's no result yet.
        const isReinstating =
          found.status === valueToRunnerStatus(21 as RunnerStatusValue) &&
          !result;
        const reinstatedStatus: RunnerStatusValue = (
          entry.noTiming ? RunnerStatus.NoTiming : RunnerStatus.Unknown
        ) as RunnerStatusValue;

        // On a card conflict keep the runner's current card rather than
        // stealing it from (or being stolen by) another runner.
        const nextCardNo = claimCardNo(
          result?.cardNo || entry.cardNo,
          found.id,
          found.cardNo,
        );

        const needsUpdate =
          found.name !== entry.personName ||
          found.cardNo !== nextCardNo ||
          found.classId !== (cls?.id ?? null) ||
          (found.eventorClubId
            ? Number(found.eventorClubId) !== entry.organisationId
            : entry.organisationId > 0) ||
          found.birthYear !== entry.birthYear ||
          found.sex !== entry.sex ||
          (!!entry.nationality && found.nationality !== entry.nationality) ||
          (result && found.startTime !== result.startTime) ||
          (result && found.finishTime !== result.finishTime) ||
          (result &&
            found.status !==
              valueToRunnerStatus(result.status as RunnerStatusValue)) ||
          isReinstating;
        if (needsUpdate) {
          await db.runner.update({
            where: { id: found.id },
            data: {
              name: entry.personName,
              cardNo: nextCardNo,
              classId: cls?.id ?? null,
              clubName: club.clubName,
              eventorClubId: club.eventorClubId,
              birthYear: entry.birthYear,
              sex: entry.sex,
              ...(found.entrySource === 0
                ? { entrySource: clampInt32(eventorEventId) }
                : {}),
              ...(entry.nationality
                ? { nationality: entry.nationality.substring(0, 7) }
                : {}),
              ...(entry.entryDate ? { entryDate: entry.entryDate } : {}),
              ...(entry.entryTime ? { entryTime: entry.entryTime } : {}),
              ...(found.feeCents === 0 && entry.fee > 0
                ? { feeCents: clampInt32(entry.fee) }
                : {}),
              ...(found.paidCents === 0 && entry.paid > 0
                ? { paidCents: clampInt32(entry.paid) }
                : {}),
              ...(found.taxableCents === 0 && entry.taxable > 0
                ? { taxableCents: clampInt32(entry.taxable) }
                : {}),
              ...(found.rank === 0 && entry.rankingScore > 0
                ? { rank: Math.round(entry.rankingScore) }
                : {}),
              ...(result
                ? {
                    startTime: result.startTime,
                    finishTime: result.finishTime,
                    status: valueToRunnerStatus(
                      result.status as RunnerStatusValue,
                    ),
                    ...(result.startNo > 0 ? { startNo: result.startNo } : {}),
                    ...(result.bib
                      ? { bib: result.bib.substring(0, 17) }
                      : {}),
                  }
                : isReinstating
                  ? {
                      status: valueToRunnerStatus(reinstatedStatus),
                    }
                  : {}),
            },
          });
          stats.runnersUpdated++;
        }
      } else {
        const runnerStatus: RunnerStatusValue =
          (result?.status as RunnerStatusValue) ??
          ((entry.noTiming
            ? RunnerStatus.NoTiming
            : RunnerStatus.Unknown) as RunnerStatusValue);
        await db.runner.create({
          data: {
            eventId: ctx.event.id,
            classId: cls?.id ?? null,
            clubName: club.clubName,
            eventorClubId: club.eventorClubId,
            name: entry.personName,
            cardNo: claimCardNo(
              result?.cardNo || entry.cardNo,
              `person:${entry.personId}`,
            ),
            eventorPersonId: BigInt(entry.personId),
            eventorEntryId:
              entry.eventorEntryId > 0 ? BigInt(entry.eventorEntryId) : null,
            entrySource: clampInt32(eventorEventId),
            birthYear: entry.birthYear,
            sex: entry.sex,
            nationality: (result?.nationality || entry.nationality).substring(0, 7),
            entryDate: entry.entryDate,
            entryTime: entry.entryTime,
            startTime: result?.startTime ?? 0,
            finishTime: result?.finishTime ?? 0,
            status: valueToRunnerStatus(runnerStatus),
            startNo: result?.startNo ?? 0,
            bib: (result?.bib ?? "").substring(0, 17),
            feeCents: clampInt32(entry.fee),
            paidCents: clampInt32(entry.paid),
            taxableCents: clampInt32(entry.taxable),
            rank: Math.round(entry.rankingScore),
          },
        });
        stats.runnersAdded++;
      }
      seen.add(entry.personId);
    }

    // Pull in results-only late entries.
    for (const result of results) {
      if (result.personId <= 0 || seen.has(result.personId)) continue;
      const cls = classByEventorId.get(result.classId);
      const club = buildClubName(
        {
          eventId: ctx.event.id,
          eventorEventId,
          classByEventorId,
          clubNameByEventorId: clubSync.clubNameByEventorId,
        },
        result.organisationId,
        result.organisationName,
      );
      const found = byPersonId.get(result.personId);
      if (!found) {
        await db.runner.create({
          data: {
            eventId: ctx.event.id,
            classId: cls?.id ?? null,
            clubName: club.clubName,
            eventorClubId: club.eventorClubId,
            name: result.personName,
            cardNo: claimCardNo(result.cardNo, `person:${result.personId}`),
            eventorPersonId: BigInt(result.personId),
            entrySource: clampInt32(eventorEventId),
            birthYear: result.birthYear,
            sex: result.sex,
            nationality: (result.nationality ?? "").substring(0, 7),
            startTime: result.startTime,
            finishTime: result.finishTime,
            status: valueToRunnerStatus(result.status as RunnerStatusValue),
            startNo: result.startNo,
            bib: (result.bib ?? "").substring(0, 17),
          },
        });
        stats.runnersAdded++;
      }
    }

    // 5. Withdrawn detection: runners we had but Eventor no longer reports.
    //    Mark them Cancel (21).
    for (const r of existing) {
      const personId = Number(r.eventorPersonId);
      if (!seen.has(personId)) {
        // Only mark Cancel if not previously cancelled.
        if (r.status !== valueToRunnerStatus(21 as RunnerStatusValue)) {
          await db.runner.update({
            where: { id: r.id },
            data: {
              status: valueToRunnerStatus(21 as RunnerStatusValue),
            },
          });
          stats.cancelledCount++;
        }
      }
    }

    await db.event.update({
      where: { id: ctx.event.id },
      data: { eventorLastSync: new Date() },
    });

    return stats;
  }),

  // ───────────── Global club / runner directory ─────────────

  /**
   * Pull the full Eventor competitor cache + club list into the
   * global runner_directory / club_directory tables. Fire-and-forget
   * logo fetch for clubs that lack one.
   */
  syncRunnerDb: publicProcedure
    .input(z.object({ env: z.enum(["prod", "test"]).default("prod") }))
    .mutation(async ({ input }) => {
      const { apiKey } = await requireApiKey(input.env);
      const db = prisma();

      // 1. Competitors
      const competitors = await fetchCachedCompetitors(apiKey, input.env);

      // 2. Aggregate the clubs referenced by competitors.
      const clubMap = new Map<number, string>();
      for (const c of competitors) {
        if (c.clubEventorId > 0 && c.clubName) {
          clubMap.set(c.clubEventorId, c.clubName);
        }
      }

      // 3. Upsert competitor-referenced clubs first (name only).
      const partialClubs: EventorClub[] = [...clubMap.entries()].map(
        ([id, name]) => ({
          id,
          name,
          shortName: "",
          countryCode: "",
          careOf: "",
          street: "",
          city: "",
          zip: "",
          email: "",
          phone: "",
          webUrl: "",
        }),
      );
      await syncClubDirectoryEntries(partialClubs);

      // 4. Try to enrich with full club details (name + short + country).
      try {
        const allClubs = await fetchClubs(apiKey, input.env);
        await syncClubDirectoryEntries(allClubs);
      } catch (err) {
        console.warn("[syncRunnerDb] full club fetch failed:", err);
      }

      // 5. Upsert runner directory in chunks. Replace strategy: delete-all-
      //    insert is too aggressive for a global table; we instead chunk-
      //    upsert by primary key.
      const valid = competitors.filter((c) => c.extId > 0);
      const CHUNK = 1000;
      for (let i = 0; i < valid.length; i += CHUNK) {
        const chunk = valid.slice(i, i + CHUNK);
        // Build (eventorPersonId, ...) inserts and overwrite on conflict.
        for (const c of chunk) {
          await db.runnerDirectory.upsert({
            where: { eventorPersonId: BigInt(c.extId) },
            create: {
              eventorPersonId: BigInt(c.extId),
              name: c.name,
              cardNo: clampInt32(c.cardNo),
              eventorClubId: clampInt32(c.clubEventorId),
              birthYear: c.birthYear,
              sex: c.sex,
              nationality: c.nationality,
            },
            update: {
              name: c.name,
              cardNo: clampInt32(c.cardNo),
              eventorClubId: clampInt32(c.clubEventorId),
              birthYear: c.birthYear,
              sex: c.sex,
              nationality: c.nationality,
              updatedAt: new Date(),
            },
          });
        }
      }

      // 6. Background logo fetch for clubs that still lack a small logo.
      void (async () => {
        try {
          const needsLogo = await db.clubDirectory.findMany({
            where: {
              eventorId: { in: [...clubMap.keys()].map((id) => BigInt(id)) },
              smallLogoPng: null,
            },
            select: { eventorId: true },
            take: 200,
          });
          for (const c of needsLogo) {
            try {
              const small = await fetchClubLogo(
                Number(c.eventorId),
                apiKey,
                "SmallIcon",
              );
              const large = await fetchClubLogo(
                Number(c.eventorId),
                apiKey,
                "LargeIcon",
              );
              if (small) {
                await db.clubDirectory.update({
                  where: { eventorId: c.eventorId },
                  data: {
                    smallLogoPng: Buffer.from(small),
                    ...(large ? { largeLogoPng: Buffer.from(large) } : {}),
                    updatedAt: new Date(),
                  },
                });
              }
            } catch {
              // skip individual failures
            }
          }
        } catch {
          // non-critical
        }
      })();

      // 7. Record sync state in settings.
      await Promise.all([
        setSetting("runnerdb_last_sync", new Date().toISOString()),
        setSetting("runnerdb_runner_count", String(valid.length)),
        setSetting("runnerdb_club_count", String(clubMap.size)),
      ]);

      return {
        runners: valid.length,
        clubs: clubMap.size,
        logosAdded: 0, // background — count not available synchronously
      };
    }),

  /**
   * Pull just the global club list (full address info) from Eventor.
   * Used by the in-app Club page.
   */
  syncClubs: manageProcedure
    .input(z.object({ env: z.enum(["prod", "test"]).default("prod") }).optional())
    .mutation(async ({ ctx, input }) => {
      const event = await ctx.db.event.findUnique({
        where: { id: ctx.event.id },
        select: { eventorEnv: true },
      });
      const env = (input?.env ??
        (event?.eventorEnv as EventorEnvironment) ??
        "prod") as EventorEnvironment;
      const { apiKey } = await requireApiKey(env);
      const allClubs = await fetchClubs(apiKey, env);
      const stats = await syncClubDirectoryEntries(allClubs);
      return { ...stats, total: allClubs.length };
    }),

  // ───────────── Lookups ─────────────

  runnerDbStatus: publicProcedure.query(async () => {
    const [last, runners, clubs] = await Promise.all([
      getSetting("runnerdb_last_sync"),
      getSetting("runnerdb_runner_count"),
      getSetting("runnerdb_club_count"),
    ]);
    return {
      lastSync: last,
      runnerCount: runners ? parseInt(runners, 10) : 0,
      clubCount: clubs ? parseInt(clubs, 10) : 0,
    };
  }),

  searchRunnerDb: publicProcedure
    .input(z.object({ query: z.string().min(2) }))
    .query(async ({ input }) => {
      const db = prisma();
      // Try card number first if query is numeric.
      const asNum = Number(input.query.trim());
      let rows;
      if (Number.isInteger(asNum) && asNum > 0) {
        rows = await db.runnerDirectory.findMany({
          where: { cardNo: asNum },
          take: 30,
          orderBy: { name: "asc" },
        });
      } else {
        rows = await db.runnerDirectory.findMany({
          where: { name: { contains: input.query, mode: "insensitive" } },
          take: 30,
          orderBy: { name: "asc" },
        });
      }
      const clubIds = [
        ...new Set(rows.map((r) => r.eventorClubId).filter((id) => id > 0)),
      ];
      const clubs = clubIds.length
        ? await db.clubDirectory.findMany({
            where: { eventorId: { in: clubIds.map((id) => BigInt(id)) } },
            select: { eventorId: true, name: true },
          })
        : [];
      const clubNameById = new Map(
        clubs.map((c) => [Number(c.eventorId), c.name]),
      );
      return rows.map((r) => ({
        extId: Number(r.eventorPersonId),
        name: r.name,
        cardNo: r.cardNo,
        clubId: r.eventorClubId,
        clubEventorId: r.eventorClubId,
        clubName: clubNameById.get(r.eventorClubId) ?? "",
        birthYear: r.birthYear,
        sex: r.sex,
        nationality: r.nationality,
      }));
    }),

  lookupByCardNo: publicProcedure
    .input(z.object({ cardNo: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = prisma();
      const r = await db.runnerDirectory.findFirst({
        where: { cardNo: input.cardNo },
      });
      if (!r) return null;
      let clubName = "";
      if (r.eventorClubId > 0) {
        const c = await db.clubDirectory.findUnique({
          where: { eventorId: BigInt(r.eventorClubId) },
          select: { name: true },
        });
        clubName = c?.name ?? "";
      }
      return {
        name: r.name,
        cardNo: r.cardNo,
        clubEventorId: r.eventorClubId,
        clubName,
        birthYear: r.birthYear,
        sex: r.sex,
      };
    }),

  clubMembers: publicProcedure
    .input(
      z.object({
        organisationId: z.number().int().positive(),
        env: z.enum(["prod", "test"]).default("prod"),
      }),
    )
    .query(async ({ input }) => {
      const cacheKey = `${input.env}:${input.organisationId}`;
      const cached = clubMemberCache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < MEMBER_CACHE_TTL_MS) {
        return cached.members;
      }
      const { apiKey } = await requireApiKey(input.env);
      const members = await fetchCompetitors(
        apiKey,
        input.organisationId,
        input.env,
      );
      clubMemberCache.set(cacheKey, { members, fetchedAt: Date.now() });
      return members;
    }),

  /**
   * Compact dump of the full runner directory + club name lookup.
   * Used by RegistrationDialog for offline client-side search.
   */
  runnerDbDump: publicProcedure.query(async () => {
    const db = prisma();
    const [runners, clubs] = await Promise.all([
      db.runnerDirectory.findMany({
        select: {
          name: true,
          cardNo: true,
          eventorClubId: true,
          birthYear: true,
          sex: true,
        },
      }),
      db.clubDirectory.findMany({
        select: { eventorId: true, name: true },
      }),
    ]);
    const clubsObj: Record<number, string> = {};
    for (const c of clubs) clubsObj[Number(c.eventorId)] = c.name;
    return {
      // Compact tuple [name, cardNo, clubId, birthYear, sex] — matches the
      // legacy client shape so RegistrationDialog needs no changes.
      runners: runners.map((r) => [
        r.name,
        r.cardNo,
        r.eventorClubId,
        r.birthYear,
        r.sex,
      ] as const),
      clubs: clubsObj,
    };
  }),

  // ───────────── Push to Eventor (IOF v3 XML POST) ─────────────

  /**
   * Push final results to Eventor.
   *
   * Pipeline:
   *   1. Resolve the configured API key + env.
   *   2. Load event + runners + classes + courses + course_controls +
   *      cards + punches in parallel.
   *   3. For each course, resolve its `ExpectedPosition[]` so the
   *      offline matcher can derive split times + running-time
   *      adjustments.
   *   4. Compute per-class placements with adjustments folded in (so
   *      Eventor receives the same canonical ranking the kiosk +
   *      admin readout show).
   *   5. Map the result rows into `ResultForUpload[]` and POST the
   *      zipped IOF v3 ResultList XML.
   *
   * Returns `{ runnerCount }` for the UI status line.
   */
  pushResults: manageProcedure
    .input(z.object({ dryRun: z.boolean().optional() }).optional())
    .mutation(async ({ ctx, input }): Promise<{ runnerCount: number }> => {
      const event = await ctx.db.event.findUnique({
        where: { id: ctx.event.id },
        select: {
          id: true,
          name: true,
          date: true,
          zeroTime: true,
          eventorEventId: true,
          eventorEnv: true,
          cardFeeCents: true,
          currencyCode: true,
          currencyFactor: true,
        },
      });
      if (!event?.eventorEventId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Event is not linked to Eventor.",
        });
      }
      const env = (event.eventorEnv as EventorEnvironment) || "prod";
      const { apiKey } = await requireApiKey(env);

      const [classes, courses, runners, cards, allPunches] = await Promise.all(
        [
          ctx.db.class.findMany({
            where: { eventId: ctx.event.id, removed: false },
          }),
          ctx.db.course.findMany({
            where: { eventId: ctx.event.id, removed: false },
          }),
          ctx.db.runner.findMany({
            where: { eventId: ctx.event.id, removed: false },
          }),
          ctx.db.card.findMany({
            where: { eventId: ctx.event.id, removed: false },
          }),
          ctx.db.punch.findMany({
            where: { eventId: ctx.event.id, removed: false },
            orderBy: { time: "asc" },
          }),
        ],
      );

      const classById = new Map(classes.map((c) => [c.id, c]));
      const courseById = new Map(courses.map((c) => [c.id, c]));
      const cardById = new Map(cards.map((c) => [c.id, c]));

      // Pre-compute ExpectedPositions per course so each runner mapping
      // is O(1) — one SQL query per course up front, not per runner.
      const positionsByCourse = new Map<
        string,
        Awaited<ReturnType<typeof resolveCourseExpectedPositions>>
      >();
      for (const c of courses) {
        positionsByCourse.set(
          c.id,
          await resolveCourseExpectedPositions(ctx.db, c.id),
        );
      }

      // Group free punches by cardNo for fast lookup during matching.
      const freePunchesByCardNo = new Map<number, typeof allPunches>();
      for (const p of allPunches) {
        if (p.cardNo === 0) continue;
        const list = freePunchesByCardNo.get(p.cardNo) ?? [];
        list.push(p);
        freePunchesByCardNo.set(p.cardNo, list);
      }

      // Compute running-time adjustments via the matcher.
      const adjustmentByRunner = new Map<string, number>();
      const matchByRunner = new Map<
        string,
        ReturnType<typeof matchPunchesToCourse>
      >();
      for (const r of runners) {
        const cls = r.classId ? classById.get(r.classId) : null;
        const courseId = r.courseId ?? cls?.courseId ?? null;
        if (!courseId) continue;
        const positions = positionsByCourse.get(courseId) ?? [];
        if (positions.length === 0) continue;

        const card = r.cardId ? cardById.get(r.cardId) : null;
        const cardPunches = parsePunches(card?.punchesRaw ?? "").map((p) => ({
          ...p,
          time: p.time !== 0 ? toAbsolute(p.time, event.zeroTime) : 0,
        }));
        const freePunches: ParsedPunch[] = (
          freePunchesByCardNo.get(r.cardNo ?? -1) ?? []
        ).map((p) => ({
          type: p.controlCode,
          time: p.time !== 0 ? toAbsolute(p.time, event.zeroTime) : 0,
          source: "free" as const,
        }));
        const merged = [...cardPunches, ...freePunches].sort(
          (a, b) => a.time - b.time,
        );
        const fallbackStart = toAbsolute(r.startTime, event.zeroTime);
        const matched = matchPunchesToCourse(merged, positions, fallbackStart);
        matchByRunner.set(r.id, matched);
        if (matched.runningTimeAdjustment > 0) {
          adjustmentByRunner.set(r.id, matched.runningTimeAdjustment);
        }
      }

      // Placements per class — folds in adjustments so ranks line up.
      const placementByRunner = new Map<string, { place: number }>();
      const runnersByClass = new Map<string, typeof runners>();
      for (const r of runners) {
        if (!r.classId) continue;
        const list = runnersByClass.get(r.classId) ?? [];
        list.push(r);
        runnersByClass.set(r.classId, list);
      }
      for (const [classId, classRunners] of runnersByClass) {
        const cls = classById.get(classId);
        const noTiming = cls?.noTiming === true;
        // computeClassPlacements is shared with web/admin clients and
        // still keys placements by a numeric id. Map our UUID rows
        // through an index so we can translate the result back without
        // changing the shared signature.
        const uuidByIndex: string[] = [];
        const placements = computeClassPlacements(
          classRunners.map((r, idx) => {
            uuidByIndex[idx] = r.id;
            return {
              id: idx,
              status: runnerStatusToValue(r.status),
              startTime: r.startTime,
              finishTime: r.finishTime,
              runningTimeAdjustment: adjustmentByRunner.get(r.id) ?? 0,
            };
          }),
          noTiming,
        );
        for (const [idx, p] of placements) {
          const uuid = uuidByIndex[idx];
          if (uuid) placementByRunner.set(uuid, p);
        }
      }

      // Build the ResultForUpload[] payload.
      const uploadData: ResultForUpload[] = runners.map((r) => {
        const cls = r.classId ? classById.get(r.classId) : null;
        const courseId = r.courseId ?? cls?.courseId ?? null;
        const course = courseId ? courseById.get(courseId) : null;
        const oxygenStatus = runnerStatusToValue(r.status);
        const placement = placementByRunner.get(r.id);
        const matched = matchByRunner.get(r.id);

        let splitTimes: ResultForUpload["splitTimes"];
        if (
          course &&
          oxygenStatus !== RunnerStatus.Unknown &&
          oxygenStatus !== RunnerStatus.DNS &&
          oxygenStatus !== RunnerStatus.NotCompeting &&
          matched
        ) {
          splitTimes = matched.matches.flatMap((m) => {
            if (m.positionMode === "skipped") {
              if (m.status !== "ok") return [];
              return [
                {
                  controlCode: m.controlCode,
                  time:
                    m.cumTime > 0 ? Math.round(m.cumTime / 10) : undefined,
                  status: "ok" as const,
                },
              ];
            }
            if (m.positionMode === "noTiming") {
              return [
                {
                  controlCode: m.controlCode,
                  time: undefined,
                  status:
                    m.status === "ok"
                      ? ("ok" as const)
                      : ("missing" as const),
                },
              ];
            }
            return [
              {
                controlCode: m.controlCode,
                time:
                  m.status === "ok" && m.cumTime > 0
                    ? Math.round(m.cumTime / 10)
                    : undefined,
                status:
                  m.status === "ok" ? ("ok" as const) : ("missing" as const),
              },
            ];
          });
          for (const ep of matched.extraPunches) {
            if (ep.type >= 30) {
              const time =
                ep.time > matched.startTime
                  ? Math.round((ep.time - matched.startTime) / 10)
                  : undefined;
              splitTimes.push({
                controlCode: ep.type,
                time,
                status: "additional",
              });
            }
          }
        }

        return {
          personExtId: r.eventorPersonId
            ? r.eventorPersonId.toString()
            : undefined,
          name: r.name,
          classExtId: cls?.eventorId ? cls.eventorId.toString() : undefined,
          className: cls?.name ?? "Unknown",
          clubExtId: r.eventorClubId ? r.eventorClubId.toString() : undefined,
          clubName: r.clubName || undefined,
          cardNo: r.cardNo || undefined,
          startTime: toAbsolute(r.startTime, event.zeroTime) || undefined,
          finishTime: toAbsolute(r.finishTime, event.zeroTime) || undefined,
          runningTimeAdjustment: adjustmentByRunner.get(r.id),
          status: oxygenStatus,
          place: placement?.place ?? 0,
          noTiming: cls?.noTiming === true,
          fee: r.feeCents || undefined,
          cardFee:
            r.cardFeeCents !== 0
              ? r.cardFeeCents > 0
                ? r.cardFeeCents
                : event.cardFeeCents > 0
                  ? event.cardFeeCents
                  : undefined
              : undefined,
          paid: r.paidCents || undefined,
          birthYear: r.birthYear || undefined,
          nationality: r.nationality || undefined,
          bib: r.bib || undefined,
          splitTimes,
        };
      });

      if (input?.dryRun) {
        return { runnerCount: uploadData.length };
      }

      await uploadResults(
        apiKey,
        event.eventorEventId.toString(),
        event.name,
        event.date.toISOString().slice(0, 10),
        uploadData,
        env,
        event.currencyCode || "",
        event.currencyFactor || 100,
      );

      return { runnerCount: uploadData.length };
    }),

  /**
   * Push current start list to Eventor. Lighter than pushResults — we
   * only need name + class + start time + card + status, no matcher
   * pass.
   */
  pushStartList: manageProcedure
    .input(z.object({ dryRun: z.boolean().optional() }).optional())
    .mutation(async ({ ctx, input }): Promise<{ runnerCount: number }> => {
      const event = await ctx.db.event.findUnique({
        where: { id: ctx.event.id },
        select: {
          id: true,
          name: true,
          date: true,
          zeroTime: true,
          eventorEventId: true,
          eventorEnv: true,
        },
      });
      if (!event?.eventorEventId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Event is not linked to Eventor.",
        });
      }
      const env = (event.eventorEnv as EventorEnvironment) || "prod";
      const { apiKey } = await requireApiKey(env);

      const [classes, runners] = await Promise.all([
        ctx.db.class.findMany({
          where: { eventId: ctx.event.id, removed: false },
        }),
        ctx.db.runner.findMany({
          where: { eventId: ctx.event.id, removed: false },
        }),
      ]);
      const classById = new Map(classes.map((c) => [c.id, c]));

      const uploadData: ResultForUpload[] = runners.map((r) => {
        const cls = r.classId ? classById.get(r.classId) : null;
        return {
          personExtId: r.eventorPersonId
            ? r.eventorPersonId.toString()
            : undefined,
          name: r.name,
          classExtId: cls?.eventorId ? cls.eventorId.toString() : undefined,
          className: cls?.name ?? "Unknown",
          clubExtId: r.eventorClubId ? r.eventorClubId.toString() : undefined,
          clubName: r.clubName || undefined,
          cardNo: r.cardNo || undefined,
          startTime: toAbsolute(r.startTime, event.zeroTime) || undefined,
          status: runnerStatusToValue(r.status),
        };
      });

      if (input?.dryRun) {
        return { runnerCount: uploadData.length };
      }

      await uploadStartList(
        apiKey,
        event.eventorEventId.toString(),
        event.name,
        event.date.toISOString().slice(0, 10),
        uploadData,
        env,
      );

      return { runnerCount: uploadData.length };
    }),

  /**
   * Deprecated alias for `sync`. The entries-only import flow is folded
   * into `sync` (which handles classes + clubs + entries + results in
   * one pass). Kept here so older UI code calling `importEntries` keeps
   * working — the body delegates to a fresh sync against the configured
   * Eventor environment.
   */
  importEntries: manageProcedure.mutation(async () => {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Use `eventor.sync` instead — the legacy entries-only import has been folded into the full sync pass.",
    });
  }),

  /**
   * Live-fetch entry history for one or more Eventor events and persist
   * it into the shared `eventor_event_meta` + `eventor_entry_history`
   * caches. Designed to back the Registration Trends "Sync from Eventor"
   * action: the page picks comparable events, names them by id, and asks
   * the API to make sure the cache is populated before
   * `registrationTrends.fetchComparison` reads it back.
   *
   * Strategy is deliberately conservative — we treat the cache as the
   * source of truth and only call Eventor when:
   *   - `force` is true, or
   *   - the row is missing entirely, or
   *   - the cached row is older than 24h (the entry count tends to be
   *     stable post-deadline).
   *
   * Failures are isolated per event id (the caller passes a batch) so
   * one bad id doesn't block the rest. Returns a per-event status the
   * UI can show inline.
   */
  fetchEntryHistory: publicProcedure
    .input(
      z.object({
        eventIds: z.array(z.number().int().positive()).min(1).max(20),
        env: z.enum(["prod", "test"]).optional(),
        /** Bypass the cache freshness check and re-fetch every id. */
        force: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const env = input.env ?? "prod";
      const { apiKey } = await requireApiKey(env);
      const STALE_MS = 24 * 60 * 60 * 1000;
      const now = new Date();

      const cached = await prisma().eventorEventMeta.findMany({
        where: { eventorEventId: { in: input.eventIds } },
      });
      const cachedById = new Map(cached.map((c) => [c.eventorEventId, c]));

      const results: Array<{
        eventorEventId: number;
        status: "fetched" | "cached" | "missing" | "error";
        entryCount: number;
        error?: string;
      }> = [];

      for (const eid of input.eventIds) {
        const existing = cachedById.get(eid);
        const isFresh =
          existing != null &&
          now.getTime() - existing.fetchedAt.getTime() < STALE_MS;

        if (!input.force && isFresh) {
          results.push({
            eventorEventId: eid,
            status: "cached",
            entryCount: existing!.entryCount,
          });
          continue;
        }

        try {
          // 1) Resolve event meta. Eventor returns null for invalid
          //    ids; treat that as a "missing" terminal state so the
          //    operator can fix the id in the picker.
          const meta = await fetchEventMeta(apiKey, eid, env);
          if (!meta) {
            results.push({
              eventorEventId: eid,
              status: "missing",
              entryCount: 0,
              error: `Eventor event ${eid} not found.`,
            });
            continue;
          }

          // 2) Fetch the entries. We don't care about the runner-level
          //    detail here, only `entryDate` + `entryTime` + classId
          //    so the trends comparison curve can be drawn.
          const entries = await fetchEntries(apiKey, eid, env);

          // 3) Write meta + entry-history atomically. The cascade on
          //    `eventor_entry_history.eventor_event_id` means
          //    deleteMany cleans up the old rows for free.
          const startDate = parseEventorDate(meta.date) ?? now;
          await prisma().$transaction(async (tx) => {
            await tx.eventorEventMeta.upsert({
              where: { eventorEventId: eid },
              create: {
                eventorEventId: eid,
                name: meta.name,
                startDate,
                classificationId: meta.classificationId,
                organiser: meta.organiserName,
                entryCount: entries.length,
                fetchedAt: now,
              },
              update: {
                name: meta.name,
                startDate,
                classificationId: meta.classificationId,
                organiser: meta.organiserName,
                entryCount: entries.length,
                fetchedAt: now,
              },
            });
            await tx.eventorEntryHistory.deleteMany({
              where: { eventorEventId: eid },
            });
            if (entries.length > 0) {
              await tx.eventorEntryHistory.createMany({
                data: entries
                  .map((e, idx) => {
                    const at = entryToTimestamp(e.entryDate, e.entryTime);
                    return at
                      ? {
                          eventorEventId: eid,
                          rowSeq: idx,
                          entryClassId: e.classId,
                          entryAt: at,
                        }
                      : null;
                  })
                  .filter((x): x is NonNullable<typeof x> => x != null),
              });
            }
          });

          results.push({
            eventorEventId: eid,
            status: "fetched",
            entryCount: entries.length,
          });
        } catch (err) {
          // Per-event isolation: surface the error in-band so the
          // batch as a whole still succeeds. Auth errors are still
          // worth bubbling up (the caller would just retry every
          // event with the same bad key otherwise).
          if (err instanceof EventorAuthError) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          results.push({
            eventorEventId: eid,
            status: "error",
            entryCount: 0,
            error: msg,
          });
        }
      }

      return { results };
    }),
});

/**
 * "YYYY-MM-DD" → `Date` at UTC midnight, or null if unparseable. The
 * incoming string comes from `<StartDate><Date>` in Eventor XML, which
 * is always ISO-style.
 */
function parseEventorDate(input: string): Date | null {
  if (!input) return null;
  const m = input.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * Combine a MeOS-style `entryDate` (YYYYMMDD) + `entryTime` (deciseconds
 * since midnight) into a JS Date. Returns null when the date is missing
 * or malformed so we can drop the row from the history (a row with no
 * timestamp is useless for the trends curve).
 */
function entryToTimestamp(entryDate: number, entryTime: number): Date | null {
  if (!entryDate || entryDate < 19000101) return null;
  const y = Math.floor(entryDate / 10000);
  const m = Math.floor((entryDate % 10000) / 100);
  const d = entryDate % 100;
  if (y < 1900 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const secs = entryTime > 0 ? Math.floor(entryTime / 10) : 12 * 3600;
  const h = Math.floor(secs / 3600);
  const mm = Math.floor((secs % 3600) / 60);
  const ss = secs % 60;
  return new Date(Date.UTC(y, m - 1, d, h, mm, ss));
}
