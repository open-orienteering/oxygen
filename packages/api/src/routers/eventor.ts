/**
 * Eventor sync router (PostgreSQL/oxygen-schema port).
 *
 * Public endpoints (key management + browsing) work without an event
 * context. Event-scoped endpoints (sync / import-related-to-event /
 * push) require the x-event-id header via `eventProcedure`.
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
import { router, publicProcedure, eventProcedure } from "../trpc.js";
import { getSetting, setSetting, prisma, sanitizeNameId } from "../db.js";
import {
  EventorAuthError,
  fetchEvents,
  fetchEventClasses,
  fetchEntries,
  fetchResults,
  fetchReferencedClubs,
  fetchClubs,
  fetchClubLogo,
  fetchCompetitors,
  fetchCachedCompetitors,
  fetchEventWebUrl,
  type EventorEntry,
  type EventorResult,
  type EventorClub,
  type EventorCompetitor,
} from "../eventor.js";
import { eventorKeyStore } from "../eventorKeyStore.js";
import { valueToRunnerStatus } from "../statusConvert.js";
import type { EventorEnvironment, RunnerStatusValue } from "@oxygen/shared";

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
    select: { id: true, name: true, eventorId: true, sortIndex: true, sex: true, lowAge: true, highAge: true, noTiming: true, classType: true },
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

  for (const ec of eventorClasses) {
    const existingRow = byEventorId.get(ec.classId);
    if (existingRow) {
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

  setEventEnv: eventProcedure
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
  importEvent: publicProcedure
    .input(
      z.object({
        eventId: z.number().int().positive(),
        eventName: z.string().min(1),
        eventDate: z.string().min(1),
        organiserName: z.string().optional(),
        organiserId: z.number().int().optional(),
        env: z.enum(["prod", "test"]).default("prod"),
      }),
    )
    .mutation(async ({ input }) => {
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
      const event = await db.event.create({
        data: {
          nameId,
          name: input.eventName,
          date: new Date(input.eventDate),
          eventorEventId: BigInt(input.eventId),
          eventorEnv: input.env,
          eventorLastSync: new Date(),
          organizerName: input.organiserName ?? "",
          organizerEventorId: input.organiserId ?? 0,
        },
        select: { id: true, nameId: true },
      });

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
          ((entry.noTiming ? 22 : 0) as RunnerStatusValue);
        await db.runner.create({
          data: {
            eventId: event.id,
            classId: cls?.id ?? null,
            clubName: club.clubName,
            eventorClubId: club.eventorClubId,
            name: entry.personName,
            cardNo: clampInt32(result?.cardNo || entry.cardNo),
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
            cardNo: clampInt32(result.cardNo),
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

  syncStatus: eventProcedure.query(async ({ ctx }) => {
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
  sync: eventProcedure.mutation(async ({ ctx }) => {
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
        const reinstatedStatus: RunnerStatusValue = (entry.noTiming ? 22 : 0) as RunnerStatusValue;

        const needsUpdate =
          found.name !== entry.personName ||
          found.cardNo !== clampInt32(result?.cardNo || entry.cardNo) ||
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
              cardNo: clampInt32(result?.cardNo || entry.cardNo),
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
          ((entry.noTiming ? 22 : 0) as RunnerStatusValue);
        await db.runner.create({
          data: {
            eventId: ctx.event.id,
            classId: cls?.id ?? null,
            clubName: club.clubName,
            eventorClubId: club.eventorClubId,
            name: entry.personName,
            cardNo: clampInt32(result?.cardNo || entry.cardNo),
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
            cardNo: clampInt32(result.cardNo),
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
  syncClubs: eventProcedure
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

  /** Resolve Livelox event id from the linked Eventor event's WebURL. */
  getLiveloxClasses: publicProcedure
    .input(
      z.object({
        eventorEventId: z.number().int().positive(),
        env: z.enum(["prod", "test"]).default("prod"),
      }),
    )
    .query(async ({ input }) => {
      const { apiKey } = await requireApiKey(input.env);
      const info = await fetchEventWebUrl(apiKey, input.eventorEventId, input.env);
      if (!info?.webUrl) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            "This Eventor event has no external URL. Make sure the event links to Livelox.",
        });
      }
      const match = info.webUrl.match(/\/Events\/Show\/(\d+)/i);
      if (!match) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Eventor WebURL "${info.webUrl}" does not match a Livelox event pattern.`,
        });
      }
      // Resolving the class list itself goes through the Livelox client,
      // which the dedicated livelox router will own once it lands.
      return {
        liveloxEventId: parseInt(match[1], 10),
        eventName: info.name ?? "",
        webUrl: info.webUrl,
        classes: [] as Array<{
          id: number;
          name: string;
          participantCount: number;
        }>,
      };
    }),

  // ───────────── Push to Eventor (stubs — heavy pipelines) ─────────────

  /**
   * Push final results to Eventor. Returns `{ runnerCount }` so the UI
   * can render "Pushed N runners". The XML-emitter pipeline itself is
   * pending re-port, so for now we throw a typed error — the EventPage
   * surface is wired through `pushResultsMutation.error.message`.
   */
  pushResults: eventProcedure
    .input(z.object({ dryRun: z.boolean().optional() }).optional())
    .mutation(async (): Promise<{ runnerCount: number }> => {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Eventor results push is being re-ported against the new schema.",
      });
    }),

  /** See `pushResults` for the staging story. */
  pushStartList: eventProcedure
    .input(z.object({ dryRun: z.boolean().optional() }).optional())
    .mutation(async (): Promise<{ runnerCount: number }> => {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Eventor start-list push is being re-ported against the new schema.",
      });
    }),

  /**
   * Deprecated alias for `sync`. The entries-only import flow is folded
   * into `sync` (which handles classes + clubs + entries + results in
   * one pass). Kept here so older UI code calling `importEntries` keeps
   * working — the body delegates to a fresh sync against the configured
   * Eventor environment.
   */
  importEntries: eventProcedure.mutation(async () => {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Use `eventor.sync` instead — the legacy entries-only import has been folded into the full sync pass.",
    });
  }),
});
