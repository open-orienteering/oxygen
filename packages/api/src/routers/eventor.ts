import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import {
  createCompetitionDatabase,
  sanitizeDbName,
  getCompetitionClient,
  ensureLogoTable,
  getSetting,
  setSetting,
  getMainDbConnection,
  ensureRunnerDbTable,
  ensureClubDbTable,
  getCurrentDbName,
} from "../db.js";
import {
  validateApiKey,
  fetchEvents,
  fetchEventClasses,
  fetchEntries,
  fetchReferencedClubs,
  fetchClubs,
  fetchResults,
  fetchClubLogo,
  fetchEventOrganiser,
  fetchCompetitors,
  fetchCachedCompetitors,
  uploadResults,
  uploadStartList,
  type ResultForUpload,
  type EventorOrganisation,
  type EventorEntry,
  type EventorClub,
  type EventorResult,
  type EventorCompetitor,
} from "../eventor.js";
import { type EventorEnvironment } from "@oxygen/shared";
import { computeClassPlacements } from "../results.js";
import { parsePunches, parseCourseControls, matchPunchesToCourse, type ParsedPunch } from "./cardReadout.js";

// In-memory store for the validated API key and organisation, keyed by environment.
const storedKeys = new Map<
  EventorEnvironment,
  { apiKey: string; org: EventorOrganisation } | null
>();
const keyLoadedFromDb = new Map<EventorEnvironment, boolean>([
  ["prod", false],
  ["test", false],
]);

/**
 * Ensure the API key for a specific environment is loaded from the database into memory.
 */
async function ensureKeyLoaded(env: EventorEnvironment): Promise<void> {
  if (keyLoadedFromDb.get(env)) return;
  keyLoadedFromDb.set(env, true);

  try {
    const settingKey =
      env === "test" ? "eventor_api_key_test" : "eventor_api_key";
    const saved = await getSetting(settingKey);
    if (saved) {
      // Validate it's still good and populate storedOrg
      const org = await validateApiKey(saved, env);
      storedKeys.set(env, { apiKey: saved, org });
    }
  } catch {
    // Key is invalid or Eventor unreachable — clear it
    storedKeys.set(env, null);
  }
}

/**
 * Get the stored API key for an environment, loading from DB if needed.
 */
async function requireApiKey(
  env: EventorEnvironment = "prod",
): Promise<{ apiKey: string; org: EventorOrganisation }> {
  await ensureKeyLoaded(env);
  const stored = storedKeys.get(env);
  if (!stored) {
    throw new Error(
      `Eventor API key for ${env} not configured. Please validate your key first.`,
    );
  }
  return stored;
}

// Cache club member lists to avoid repeated Eventor API calls
const MEMBER_CACHE_TTL_MS = 10 * 60_000; // 10 minutes
const clubMemberCache = new Map<
  number,
  { members: EventorCompetitor[]; fetchedAt: number }
>();

export const eventorRouter = router({
  /**
   * Validate an Eventor API key and store it for subsequent requests.
   * Persists to MeOSMain.oxygen_settings so it survives server restarts.
   */
  validateKey: publicProcedure
    .input(
      z.object({
        apiKey: z.string().min(1),
        env: z.enum(["prod", "test"]).default("prod"),
      }),
    )
    .mutation(async ({ input }) => {
      const org = await validateApiKey(input.apiKey, input.env);
      storedKeys.set(input.env, { apiKey: input.apiKey, org });
      keyLoadedFromDb.set(input.env, true);

      // Persist to database
      const settingKey =
        input.env === "test" ? "eventor_api_key_test" : "eventor_api_key";
      await setSetting(settingKey, input.apiKey);

      return {
        organisationId: org.id,
        organisationName: org.name,
      };
    }),

  /**
   * Clear the stored Eventor API key (for testing or switching).
   */
  clearKey: publicProcedure
    .input(z.object({ env: z.enum(["prod", "test"]).default("prod") }))
    .mutation(async ({ input }) => {
      storedKeys.set(input.env, null);
      const settingKey =
        input.env === "test" ? "eventor_api_key_test" : "eventor_api_key";
      await setSetting(settingKey, null);
      return { success: true };
    }),

  /**
   * Get the currently stored key status (without exposing the key).
   * Restores from persistent storage on first call after server start.
   */
  keyStatus: publicProcedure
    .input(z.object({ env: z.enum(["prod", "test"]).default("prod") }))
    .query(async ({ input }) => {
      await ensureKeyLoaded(input.env);
      const stored = storedKeys.get(input.env);
      if (!stored) {
        return { connected: false as const };
      }
      return {
        connected: true as const,
        organisationId: stored.org.id,
        organisationName: stored.org.name,
      };
    }),

  /**
   * Fetch events from Eventor for the configured organisation.
   */
  events: publicProcedure
    .input(
      z.object({
        fromDate: z.string().optional(),
        toDate: z.string().optional(),
        env: z.enum(["prod", "test"]).default("prod"),
      }).optional(),
    )
    .query(async ({ input }) => {
      const { apiKey, org } = await requireApiKey(input?.env);

      // Default: from 6 months ago to 6 months ahead
      const now = new Date();
      const sixMonthsAgo = new Date(now);
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      const sixMonthsAhead = new Date(now);
      sixMonthsAhead.setMonth(sixMonthsAhead.getMonth() + 6);

      const fromDate = input?.fromDate ?? formatDate(sixMonthsAgo);
      const toDate = input?.toDate ?? formatDate(sixMonthsAhead);

      const events = await fetchEvents(
        apiKey,
        org.id,
        fromDate,
        toDate,
        input?.env,
      );

      return events;
    }),

  /**
   * Get detail for a specific event: classes and entry count.
   */
  eventDetail: publicProcedure
    .input(z.object({
      eventId: z.number().int().positive(),
      env: z.enum(["prod", "test"]).default("prod"),
    }))
    .query(async ({ input }) => {
      const { apiKey } = await requireApiKey(input.env);

      const [classes, entries] = await Promise.all([
        fetchEventClasses(apiKey, input.eventId, input.env),
        fetchEntries(apiKey, input.eventId, input.env),
      ]);

      // Count entries per class
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

  /**
   * Import an event from Eventor into a new local database.
   * Creates the DB, imports classes, clubs, and entries.
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

      // 1. Create the database
      const { dbName } = await createCompetitionDatabase(
        input.eventName,
        input.eventDate,
      );

      // 2. Fetch data from Eventor (classes, entries, and results in parallel)
      const [classes, entries, results] = await Promise.all([
        fetchEventClasses(apiKey, input.eventId, input.env),
        fetchEntries(apiKey, input.eventId, input.env),
        fetchResults(apiKey, input.eventId, input.env),
      ]);

      // Build results lookup by personId for merging
      const resultsMap = new Map<number, EventorResult>();
      for (const r of results) {
        if (r.personId > 0) resultsMap.set(r.personId, r);
      }

      // For clubs, merge data from both entries and results
      const clubMap = await fetchReferencedClubs(apiKey, entries);
      // Add clubs from results that weren't in entries (e.g., DNS runners not in entry list)
      for (const r of results) {
        if (r.organisationId > 0 && !clubMap.has(r.organisationId)) {
          clubMap.set(r.organisationId, {
            id: r.organisationId,
            name: r.organisationName,
            shortName: r.organisationShortName,
            countryCode: r.organisationCountry || "",
            careOf: "", street: "", city: "", zip: "", email: "", phone: "",
          });
        }
      }

      // 3. Get the Prisma client for the new database
      const client = await getCompetitionClient(dbName);

      // 4. Import clubs
      const eventorToLocalClub = new Map<number, number>();
      let clubSortId = 1;
      for (const [eventorId, club] of clubMap) {
        const created = await client.oClub.create({
          data: {
            Id: clubSortId,
            Name: club.name,
            ShortName: (club.shortName || club.name).substring(0, 17),
            ExtId: BigInt(eventorId),
            ...(club.countryCode ? { Nationality: club.countryCode.substring(0, 7) } : {}),
            ...(club.careOf ? { CareOf: club.careOf.substring(0, 63) } : {}),
            ...(club.street ? { Street: club.street.substring(0, 83) } : {}),
            ...(club.city ? { City: club.city.substring(0, 47) } : {}),
            ...(club.zip ? { ZIP: club.zip.substring(0, 23) } : {}),
            ...(club.email ? { EMail: club.email.substring(0, 129) } : {}),
            ...(club.phone ? { Phone: club.phone.substring(0, 65) } : {}),
          },
        });
        eventorToLocalClub.set(eventorId, created.Id);
        clubSortId++;
      }

      // 5. Import classes — use Eventor sequence for sort order
      const eventorToLocalClass = new Map<number, number>();
      let fallbackSortIdx = 0;
      for (const cls of classes) {
        fallbackSortIdx += 10;
        const created = await client.oClass.create({
          data: {
            Name: cls.name,
            SortIndex: cls.sequence > 0 ? cls.sequence : fallbackSortIdx,
            ExtId: BigInt(cls.classId),
            MultiCourse: "",
            Qualification: "",
            Sex: cls.sex || "",
            LowAge: cls.lowAge,
            HighAge: cls.highAge,
            ClassType: cls.classType.substring(0, 81),
            NoTiming: cls.noTiming ? 1 : 0,
          },
        });
        eventorToLocalClass.set(cls.classId, created.Id);
      }

      // 6. Import runners — merge entries with results
      // Build a unified set of runners: start from entries, overlay results
      const seenPersonIds = new Set<number>();
      let runnerCount = 0;

      for (const entry of entries) {
        const localClubId = eventorToLocalClub.get(entry.organisationId) ?? 0;
        const localClassId = eventorToLocalClass.get(entry.classId) ?? 0;
        const result = resultsMap.get(entry.personId);

        // Determine status: NoTiming takes priority if no result status exists
        const runnerStatus = result?.status ?? (entry.noTiming ? 22 : 0); // 22 = StatusNoTiming in MeOS
        const bibStr = result?.bib ?? "";

        await client.oRunner.create({
          data: {
            Name: entry.personName,
            CardNo: result?.cardNo || entry.cardNo,
            Club: localClubId,
            Class: localClassId,
            ExtId: BigInt(entry.personId),
            EntrySource: input.eventId, // MeOS entrySourceId = Eventor event ID
            BirthYear: entry.birthYear,
            Sex: entry.sex,
            Nationality: (result?.nationality || entry.nationality).substring(0, 7),
            EntryDate: entry.entryDate,
            EntryTime: entry.entryTime,
            StartTime: result?.startTime ?? 0,
            FinishTime: result?.finishTime ?? 0,
            Status: runnerStatus,
            StartNo: result?.startNo ?? 0,
            Bib: bibStr.substring(0, 17),
            Fee: entry.fee,
            Paid: entry.paid,
            Taxable: entry.taxable,
            Rank: Math.round(entry.rankingScore),
            InputResult: "",
            Annotation: "",
          },
        });
        seenPersonIds.add(entry.personId);
        runnerCount++;
      }

      // Also import runners from results who weren't in entries
      // (e.g., late registrations added directly on event day)
      for (const result of results) {
        if (result.personId > 0 && !seenPersonIds.has(result.personId)) {
          const localClubId = eventorToLocalClub.get(result.organisationId) ?? 0;
          const localClassId = eventorToLocalClass.get(result.classId) ?? 0;

          await client.oRunner.create({
            data: {
              Name: result.personName,
              CardNo: result.cardNo,
              Club: localClubId,
              Class: localClassId,
              ExtId: BigInt(result.personId),
              EntrySource: input.eventId, // MeOS entrySourceId = Eventor event ID
              BirthYear: result.birthYear,
              Sex: result.sex,
              Nationality: result.nationality.substring(0, 7),
              StartTime: result.startTime,
              FinishTime: result.finishTime,
              Status: result.status,
              StartNo: result.startNo,
              Bib: result.bib.substring(0, 17),
              InputResult: "",
              Annotation: "",
            },
          });
          seenPersonIds.add(result.personId);
          runnerCount++;
        }
      }

      // 7. Derive class fees from runner entry fees
      await deriveClassFees(client);

      // 8. Store Eventor event ID, organiser, and sync timestamp in oEvent
      const event = await client.oEvent.findFirst({ where: { Removed: false } });
      if (event) {
        // Resolve organiser name: use provided name, or look up club by ExtId
        let orgName = input.organiserName ?? "";
        const orgId = input.organiserId ?? 0;
        if (!orgName && orgId > 0) {
          const club = await client.oClub.findFirst({
            where: { ExtId: orgId, Removed: false },
            select: { Name: true },
          });
          orgName = club?.Name ?? "";
        }

        // Store plain text organizer name (MeOS format — no tab-delimited clubId)
        const organizerValue = orgName || "";

        await client.oEvent.update({
          where: { Id: event.Id },
          data: {
            ExtId: BigInt(input.eventId),
            ImportStamp: new Date().toISOString(),
            ...(organizerValue ? { Organizer: organizerValue } : {}),
          },
        });

        // Store centrally for lookup in competition list and sync procedures
        await setSetting(`eventor_env_${dbName}`, input.env);
      }

      // 7b. Fetch organiser logo if available
      if (input.organiserId && input.organiserId > 0) {
        const [small, large] = await Promise.all([
          fetchClubLogo(input.organiserId, apiKey, "SmallIcon"),
          fetchClubLogo(input.organiserId, apiKey, "LargeIcon"),
        ]);
        if (small) {
          await ensureLogoTable(client);
          await client.oxygen_club_logo.upsert({
            where: { EventorId: input.organiserId },
            create: { EventorId: input.organiserId, SmallPng: small as any, ...(large ? { LargePng: large as any } : {}) },
            update: { SmallPng: small as any, ...(large ? { LargePng: large as any } : {}), UpdatedAt: new Date() },
          });
        }
      }

      return {
        dbName,
        nameId: dbName,
        classCount: classes.length,
        clubCount: clubMap.size,
        runnerCount,
      };
    }),

  /**
   * Get Eventor sync status for the current competition.
   * Returns the linked Eventor event ID and last sync time.
   */
  syncStatus: publicProcedure.query(async () => {
    const client = await getCompetitionClient();
    const event = await client.oEvent.findFirst({ where: { Removed: false } });

    const dbName = getCurrentDbName();
    const envSuffix = (await getSetting(`eventor_env_${dbName}`)) as
      | EventorEnvironment
      | null;
    const env = envSuffix ?? "prod";

    await ensureKeyLoaded(env);
    const stored = storedKeys.get(env);

    if (!event) {
      return { linked: false as const, apiKeyConfigured: !!stored, env };
    }

    const eventorEventId = Number(event.ExtId);
    if (!eventorEventId) {
      return {
        linked: false as const,
        apiKeyConfigured: !!stored,
        env,
      };
    }

    return {
      linked: true as const,
      eventorEventId,
      lastSync: event.ImportStamp || null,
      apiKeyConfigured: !!stored,
      env,
    };
  }),

  /**
   * Incremental sync: update classes, clubs, and entries from Eventor.
   * Matches by ExtId (Eventor IDs) and adds/updates as needed.
   */
  sync: publicProcedure.mutation(async () => {
    const client = await getCompetitionClient();
    const dbName = getCurrentDbName();
    const env = ((await getSetting(`eventor_env_${dbName}`)) ??
      "prod") as EventorEnvironment;
    const { apiKey } = await requireApiKey(env);

    const event = await client.oEvent.findFirst({ where: { Removed: false } });
    if (!event || !Number(event.ExtId)) {
      throw new Error("This competition is not linked to an Eventor event");
    }

    const eventorEventId = Number(event.ExtId);
    const stats = { classesAdded: 0, classesUpdated: 0, clubsAdded: 0, clubsUpdated: 0, runnersAdded: 0, runnersUpdated: 0 };

    // 1. Sync classes
    const eventorClasses = await fetchEventClasses(apiKey, eventorEventId, env);
    const existingClasses = await client.oClass.findMany({ where: { Removed: false } });
    const classExtIdMap = new Map(existingClasses.map((c) => [Number(c.ExtId), c]));

    // Build mapping for runner import
    const eventorToLocalClass = new Map<number, number>();
    let maxSortIdx = Math.max(0, ...existingClasses.map((c) => c.SortIndex));

    for (const ec of eventorClasses) {
      const existing = classExtIdMap.get(ec.classId);
      if (existing) {
        // Update name, sex, age, sortIndex, classType if changed
        const noTimingVal = ec.noTiming ? 1 : 0;
        const needsUpdate =
          existing.Name !== ec.name ||
          existing.Sex !== (ec.sex || "") ||
          existing.LowAge !== ec.lowAge ||
          existing.HighAge !== ec.highAge ||
          existing.NoTiming !== noTimingVal ||
          (ec.sequence > 0 && existing.SortIndex !== ec.sequence) ||
          (ec.classType && existing.ClassType !== ec.classType);
        if (needsUpdate) {
          await client.oClass.update({
            where: { Id: existing.Id },
            data: {
              Name: ec.name,
              Sex: ec.sex || "",
              LowAge: ec.lowAge,
              HighAge: ec.highAge,
              NoTiming: noTimingVal,
              ...(ec.sequence > 0 ? { SortIndex: ec.sequence } : {}),
              ...(ec.classType ? { ClassType: ec.classType.substring(0, 81) } : {}),
            },
          });
          stats.classesUpdated++;
        }
        eventorToLocalClass.set(ec.classId, existing.Id);
      } else {
        maxSortIdx += 10;
        const created = await client.oClass.create({
          data: {
            Name: ec.name,
            SortIndex: ec.sequence > 0 ? ec.sequence : maxSortIdx,
            ExtId: BigInt(ec.classId),
            MultiCourse: "",
            Qualification: "",
            Sex: ec.sex || "",
            LowAge: ec.lowAge,
            HighAge: ec.highAge,
            ClassType: ec.classType.substring(0, 81),
            NoTiming: ec.noTiming ? 1 : 0,
          },
        });
        eventorToLocalClass.set(ec.classId, created.Id);
        stats.classesAdded++;
      }
    }

    // 2. Sync entries and results (runners)
    const [eventorEntries, eventorResults] = await Promise.all([
      fetchEntries(apiKey, eventorEventId, env),
      fetchResults(apiKey, eventorEventId, env),
    ]);

    // Build results lookup by personId
    const resultsMap = new Map<number, EventorResult>();
    for (const r of eventorResults) {
      if (r.personId > 0) resultsMap.set(r.personId, r);
    }

    // Sync referenced clubs first (from both entries and results)
    const allEntryLikeData: EventorEntry[] = [...eventorEntries];
    // Add results-only runners as pseudo-entries for club sync
    for (const r of eventorResults) {
      if (r.organisationId > 0) {
        const alreadyInEntries = eventorEntries.some((e) => e.organisationId === r.organisationId);
        if (!alreadyInEntries) {
          allEntryLikeData.push({
            personName: r.personName, personId: r.personId, birthYear: r.birthYear,
            sex: r.sex, nationality: r.nationality,
            organisationId: r.organisationId, organisationName: r.organisationName,
            organisationShortName: r.organisationShortName, organisationCountry: r.organisationCountry,
            classId: r.classId, className: "", cardNo: r.cardNo,
            eventorEntryId: 0, entryDate: 0, entryTime: 0,
            fee: 0, paid: 0, taxable: 0, rankingScore: 0, noTiming: false,
          });
        }
      }
    }
    const clubResult = await syncClubsFromEntries(client, allEntryLikeData, apiKey);
    stats.clubsAdded = clubResult.added;
    stats.clubsUpdated = clubResult.updated;
    const eventorToLocalClub = clubResult.mapping;

    // Now sync runners
    const existingRunners = await client.oRunner.findMany({ where: { Removed: false } });
    const runnerExtIdMap = new Map(
      existingRunners.filter((r) => Number(r.ExtId) > 0).map((r) => [Number(r.ExtId), r]),
    );
    const seenPersonIds = new Set<number>();

    for (const entry of eventorEntries) {
      const localClubId = eventorToLocalClub.get(entry.organisationId) ?? 0;
      const localClassId = eventorToLocalClass.get(entry.classId) ?? 0;
      const result = resultsMap.get(entry.personId);

      const existing = runnerExtIdMap.get(entry.personId);
      if (existing) {
        const needsUpdate =
          existing.Name !== entry.personName ||
          existing.CardNo !== (result?.cardNo || entry.cardNo) ||
          existing.Class !== localClassId ||
          existing.Club !== localClubId ||
          existing.BirthYear !== entry.birthYear ||
          existing.Sex !== entry.sex ||
          (entry.nationality && existing.Nationality !== entry.nationality) ||
          (result && existing.StartTime !== result.startTime) ||
          (result && existing.FinishTime !== result.finishTime) ||
          (result && existing.Status !== result.status);

        if (needsUpdate) {
          await client.oRunner.update({
            where: { Id: existing.Id },
            data: {
              Name: entry.personName,
              CardNo: result?.cardNo || entry.cardNo,
              Class: localClassId,
              Club: localClubId,
              BirthYear: entry.birthYear,
              Sex: entry.sex,
              // Set EntrySource if not already set (preserve existing value)
              ...(existing.EntrySource === 0 ? { EntrySource: eventorEventId } : {}),
              ...(entry.nationality ? { Nationality: entry.nationality.substring(0, 7) } : {}),
              ...(entry.entryDate ? { EntryDate: entry.entryDate } : {}),
              ...(entry.entryTime ? { EntryTime: entry.entryTime } : {}),
              // Only update fees if none set locally (don't overwrite manual payment edits)
              ...(existing.Fee === 0 && entry.fee > 0 ? { Fee: entry.fee } : {}),
              ...(existing.Paid === 0 && entry.paid > 0 ? { Paid: entry.paid } : {}),
              ...(existing.Taxable === 0 && entry.taxable > 0 ? { Taxable: entry.taxable } : {}),
              ...(existing.Rank === 0 && entry.rankingScore > 0 ? { Rank: Math.round(entry.rankingScore) } : {}),
              ...(result ? {
                StartTime: result.startTime,
                FinishTime: result.finishTime,
                Status: result.status,
                ...(result.startNo > 0 ? { StartNo: result.startNo } : {}),
                ...(result.bib ? { Bib: result.bib.substring(0, 17) } : {}),
              } : {}),
            },
          });
          stats.runnersUpdated++;
        }
      } else {
        const runnerStatus = result?.status ?? (entry.noTiming ? 22 : 0);
        await client.oRunner.create({
          data: {
            Name: entry.personName,
            CardNo: result?.cardNo || entry.cardNo,
            Club: localClubId,
            Class: localClassId,
            ExtId: BigInt(entry.personId),
            EntrySource: eventorEventId,
            BirthYear: entry.birthYear,
            Sex: entry.sex,
            Nationality: (result?.nationality || entry.nationality).substring(0, 7),
            EntryDate: entry.entryDate,
            EntryTime: entry.entryTime,
            StartTime: result?.startTime ?? 0,
            FinishTime: result?.finishTime ?? 0,
            Status: runnerStatus,
            StartNo: result?.startNo ?? 0,
            Bib: (result?.bib ?? "").substring(0, 17),
            Fee: entry.fee,
            Paid: entry.paid,
            Taxable: entry.taxable,
            Rank: Math.round(entry.rankingScore),
            InputResult: "",
            Annotation: "",
          },
        });
        stats.runnersAdded++;
      }
      seenPersonIds.add(entry.personId);
    }

    // Import runners who are only in results (not in entries)
    for (const result of eventorResults) {
      if (result.personId > 0 && !seenPersonIds.has(result.personId)) {
        const localClubId = eventorToLocalClub.get(result.organisationId) ?? 0;
        const localClassId = eventorToLocalClass.get(result.classId) ?? 0;
        const existing = runnerExtIdMap.get(result.personId);

        if (existing) {
          const needsUpdate =
            existing.StartTime !== result.startTime ||
            existing.FinishTime !== result.finishTime ||
            existing.Status !== result.status;
          if (needsUpdate) {
            await client.oRunner.update({
              where: { Id: existing.Id },
              data: {
                Name: result.personName,
                CardNo: result.cardNo,
                Club: localClubId,
                Class: localClassId,
                StartTime: result.startTime,
                FinishTime: result.finishTime,
                Status: result.status,
                ...(result.startNo > 0 ? { StartNo: result.startNo } : {}),
                ...(result.bib ? { Bib: result.bib.substring(0, 17) } : {}),
                ...(result.nationality ? { Nationality: result.nationality.substring(0, 7) } : {}),
                ...(existing.EntrySource === 0 ? { EntrySource: eventorEventId } : {}),
              },
            });
            stats.runnersUpdated++;
          }
        } else {
          await client.oRunner.create({
            data: {
              Name: result.personName,
              CardNo: result.cardNo,
              Club: localClubId,
              Class: localClassId,
              ExtId: BigInt(result.personId),
              EntrySource: eventorEventId,
              BirthYear: result.birthYear,
              Sex: result.sex,
              Nationality: result.nationality.substring(0, 7),
              StartTime: result.startTime,
              FinishTime: result.finishTime,
              Status: result.status,
              StartNo: result.startNo,
              Bib: result.bib.substring(0, 17),
              InputResult: "",
              Annotation: "",
            },
          });
          stats.runnersAdded++;
        }
        seenPersonIds.add(result.personId);
      }
    }

    // 4. Mark withdrawn runners as Cancelled (StatusCANCEL = 21)
    // Any runner who came from Eventor (has ExtId) but no longer appears
    // in either entries or results, and hasn't been given a real race status,
    // is treated as having cancelled their entry ("Återbud" in MeOS).
    let cancelledCount = 0;
    for (const runner of existingRunners) {
      const extId = Number(runner.ExtId);
      if (extId > 0 && !seenPersonIds.has(extId)) {
        // Only mark as cancelled if they haven't actually raced yet
        // (Status 0 = unknown/no status). Don't overwrite DNS, OK, DNF, etc.
        if (runner.Status === 0) {
          await client.oRunner.update({
            where: { Id: runner.Id },
            data: { Status: 21 }, // StatusCANCEL
          });
          cancelledCount++;
        }
      }
    }

    // 5. Derive class fees from runner entry fees
    await deriveClassFees(client);

    // 6. Update sync timestamp (and organizer if missing)
    const syncUpdateData: Record<string, unknown> = { ImportStamp: new Date().toISOString() };
    if (!event.Organizer) {
      const organiser = await fetchEventOrganiser(apiKey, eventorEventId, env);
      if (organiser?.name) syncUpdateData.Organizer = organiser.name;
      // Fetch and store organiser logo if available
      if (organiser?.id && organiser.id > 0) {
        try {
          const [small, large] = await Promise.all([
            fetchClubLogo(organiser.id, apiKey, "SmallIcon"),
            fetchClubLogo(organiser.id, apiKey, "LargeIcon"),
          ]);
          if (small) {
            await ensureLogoTable(client);
            await client.oxygen_club_logo.upsert({
              where: { EventorId: organiser.id },
              create: { EventorId: organiser.id, SmallPng: small as any, ...(large ? { LargePng: large as any } : {}) },
              update: { SmallPng: small as any, ...(large ? { LargePng: large as any } : {}), UpdatedAt: new Date() },
            });
          }
        } catch {
          // Logo fetch failure is not critical
        }
      }
    }
    await client.oEvent.update({
      where: { Id: event.Id },
      data: syncUpdateData,
    });

    return { ...stats, cancelledCount };
  }),

  /**
   * Push current results to Eventor.
   * Only enabled for Test-Eventor for safety.
   */
  pushResults: publicProcedure.mutation(async () => {
    const client = await getCompetitionClient();
    const dbName = getCurrentDbName();
    const env = ((await getSetting(`eventor_env_${dbName}`)) ??
      "prod") as EventorEnvironment;

    if (env !== "test") {
      throw new Error("Pushing results is only supported for Test-Eventor.");
    }

    const { apiKey } = await requireApiKey(env);

    const [event, classes, runners, clubs, courses, allPunches, allCards] = await Promise.all([
      client.oEvent.findFirst({ where: { Removed: false } }),
      client.oClass.findMany({ where: { Removed: false } }),
      client.oRunner.findMany({ where: { Removed: false } }),
      client.oClub.findMany({ where: { Removed: false } }),
      client.oCourse.findMany({ where: { Removed: false } }),
      client.oPunch.findMany({ where: { Removed: false }, orderBy: { Time: "asc" } }),
      client.oCard.findMany({ where: { Removed: false } }),
    ]);

    if (!event || !event.ExtId) {
      throw new Error("Competition not linked to Eventor.");
    }

    const classMap = new Map(classes.map((c) => [c.Id, c]));
    const clubMap = new Map(clubs.map((c) => [c.Id, c]));
    const courseMap = new Map(courses.map((c) => [c.Id, c]));
    const cardById = new Map(allCards.map((c) => [c.Id, c]));

    // Group free punches by CardNo for efficient lookup
    const punchesByCardNo = new Map<number, typeof allPunches>();
    for (const p of allPunches) {
      const list = punchesByCardNo.get(p.CardNo) ?? [];
      list.push(p);
      punchesByCardNo.set(p.CardNo, list);
    }

    // Group runners by class and compute placements once
    const byClass = new Map<number, typeof runners>();
    for (const r of runners) {
      const list = byClass.get(r.Class) ?? [];
      list.push(r);
      byClass.set(r.Class, list);
    }

    const placementByRunner = new Map<number, { place: number }>();
    for (const [classId, classRunners] of byClass) {
      const cls = classMap.get(classId);
      const noTiming = cls?.NoTiming === 1;
      const placements = computeClassPlacements(
        classRunners.map((r) => ({
          id: r.Id,
          status: r.Status,
          startTime: r.StartTime,
          finishTime: r.FinishTime,
        })),
        noTiming,
      );
      for (const [id, p] of placements) {
        placementByRunner.set(id, p);
      }
    }

    const uploadData: ResultForUpload[] = runners.map((r) => {
      const cls = classMap.get(r.Class);
      const club = clubMap.get(r.Club);
      const p = placementByRunner.get(r.Id);

      // Late fee detection (matching MeOS hasLateEntryFee, oRunner.cpp:7240)
      let isLateFee = false;
      if (cls && r.Fee > 0) {
        const normalFee = cls.ClassFee;
        const highFee = cls.HighClassFee;
        const highFee2 = cls.SecondHighClassFee;
        if (r.Fee !== normalFee && normalFee > 0) {
          if ((r.Fee === highFee && highFee > normalFee) ||
              (r.Fee === highFee2 && highFee2 > normalFee)) {
            isLateFee = true;
          }
        }
      }

      // Normalize BirthYear (MeOS stores YYYY or YYYYMMDD)
      const birthYear = r.BirthYear > 9999
        ? Math.floor(r.BirthYear / 10000)
        : r.BirthYear;

      // Compute split times from punches + course
      let splitTimes: ResultForUpload["splitTimes"];
      const courseId = r.Course || cls?.Course || 0;
      const course = courseId ? courseMap.get(courseId) : undefined;
      // Only compute splits for runners with a result (status > 0, not DNS/Cancel)
      if (course && r.Status > 0 && r.Status !== 20 && r.Status !== 99) {
        const courseControls = parseCourseControls(course.Controls);
        if (courseControls.length > 0) {
          // Merge card punches + free punches
          const card = r.Card ? cardById.get(r.Card) : undefined;
          const cardPunches = parsePunches(card?.Punches ?? "");
          const freePunches: ParsedPunch[] = (punchesByCardNo.get(r.CardNo) ?? []).map((p) => ({
            type: p.Type,
            time: p.Time,
            source: "free" as const,
          }));
          const merged = [...cardPunches, ...freePunches].sort((a, b) => a.time - b.time);
          const { matches, extraPunches, startTime } = matchPunchesToCourse(merged, courseControls, r.StartTime);

          splitTimes = matches.map((m) => ({
            controlCode: m.controlCode,
            time: m.status === "ok" && m.cumTime > 0 ? Math.round(m.cumTime / 10) : undefined,
            status: m.status === "ok" ? "ok" as const : "missing" as const,
          }));
          // Add extra punches as "additional" (control codes >= 30, matching MeOS filter)
          for (const ep of extraPunches) {
            if (ep.type >= 30) {
              const time = ep.time > startTime ? Math.round((ep.time - startTime) / 10) : undefined;
              splitTimes.push({ controlCode: ep.type, time, status: "additional" });
            }
          }
        }
      }

      return {
        personExtId: r.ExtId ? r.ExtId.toString() : undefined,
        name: r.Name,
        classExtId: cls?.ExtId ? cls.ExtId.toString() : undefined,
        className: cls?.Name || "Unknown",
        clubExtId: club?.ExtId ? club.ExtId.toString() : undefined,
        clubName: club?.Name || undefined,
        cardNo: r.CardNo || undefined,
        startTime: r.StartTime || undefined,
        finishTime: r.FinishTime || undefined,
        status: r.Status,
        place: p?.place ?? 0,
        noTiming: cls?.NoTiming === 1,
        fee: r.Fee || undefined,
        cardFee: r.CardFee || undefined,
        paid: r.Paid || undefined,
        taxable: r.Taxable || undefined,
        isLateFee,
        birthYear: birthYear || undefined,
        nationality: r.Nationality || undefined,
        bib: r.Bib || undefined,
        splitTimes,
      };
    });

    await uploadResults(
      apiKey,
      event.ExtId.toString(),
      event.Name,
      event.Date,
      uploadData,
      env,
      event.CurrencyCode || "",
      event.CurrencyFactor || 100,
    );

    return { success: true, runnerCount: uploadData.length };
  }),

  /**
   * Push current start list to Eventor.
   * Only enabled for Test-Eventor for safety.
   */
  pushStartList: publicProcedure.mutation(async () => {
    const client = await getCompetitionClient();
    const dbName = getCurrentDbName();
    const env = ((await getSetting(`eventor_env_${dbName}`)) ??
      "prod") as EventorEnvironment;

    if (env !== "test") {
      throw new Error("Pushing start list is only supported for Test-Eventor.");
    }

    const { apiKey } = await requireApiKey(env);

    const [event, classes, runners, clubs] = await Promise.all([
      client.oEvent.findFirst({ where: { Removed: false } }),
      client.oClass.findMany({ where: { Removed: false } }),
      client.oRunner.findMany({ where: { Removed: false } }),
      client.oClub.findMany({ where: { Removed: false } }),
    ]);

    if (!event || !event.ExtId) {
      throw new Error("Competition not linked to Eventor.");
    }

    const classMap = new Map(classes.map((c) => [c.Id, c]));
    const clubMap = new Map(clubs.map((c) => [c.Id, c]));

    const uploadData: ResultForUpload[] = runners.map((r) => {
      const cls = classMap.get(r.Class);
      const club = clubMap.get(r.Club);
      return {
        personExtId: r.ExtId ? r.ExtId.toString() : undefined,
        name: r.Name,
        classExtId: cls?.ExtId ? cls.ExtId.toString() : undefined,
        className: cls?.Name || "Unknown",
        clubExtId: club?.ExtId ? club.ExtId.toString() : undefined,
        clubName: club?.Name || undefined,
        cardNo: r.CardNo || undefined,
        startTime: r.StartTime || undefined,
        status: r.Status,
      };
    });

    await uploadStartList(
      apiKey,
      event.ExtId.toString(),
      event.Name,
      event.Date,
      uploadData,
      env,
    );

    return { success: true, runnerCount: uploadData.length };
  }),

  /**
   * Sync club list from Eventor into the current competition.
   */
  syncClubs: publicProcedure.mutation(async () => {
    const client = await getCompetitionClient();
    const dbName = getCurrentDbName();
    const env = ((await getSetting(`eventor_env_${dbName}`)) ??
      "prod") as EventorEnvironment;
    const { apiKey } = await requireApiKey(env);

    const allClubs = await fetchClubs(apiKey, env);

    const existingClubs = await client.oClub.findMany({ where: { Removed: false } });
    const clubExtIdMap = new Map(
      existingClubs.filter((c) => Number(c.ExtId) > 0).map((c) => [Number(c.ExtId), c]),
    );

    let added = 0;
    let updated = 0;

    for (const club of allClubs) {
      if (!club.id || !club.name) continue;

      const clubData = {
        Name: club.name,
        ShortName: (club.shortName || club.name).substring(0, 17),
        ...(club.countryCode ? { Nationality: club.countryCode.substring(0, 7) } : {}),
        ...(club.careOf ? { CareOf: club.careOf.substring(0, 63) } : {}),
        ...(club.street ? { Street: club.street.substring(0, 83) } : {}),
        ...(club.city ? { City: club.city.substring(0, 47) } : {}),
        ...(club.zip ? { ZIP: club.zip.substring(0, 23) } : {}),
        ...(club.email ? { EMail: club.email.substring(0, 129) } : {}),
        ...(club.phone ? { Phone: club.phone.substring(0, 65) } : {}),
      };

      const existing = clubExtIdMap.get(club.id);
      if (existing) {
        const needsUpdate =
          existing.Name !== club.name ||
          (club.countryCode && existing.Nationality !== club.countryCode) ||
          (club.street && existing.Street !== club.street) ||
          (club.city && existing.City !== club.city) ||
          (club.zip && existing.ZIP !== club.zip);
        if (needsUpdate) {
          await client.oClub.update({
            where: { Id: existing.Id },
            data: clubData,
          });
          updated++;
        }
      } else {
        await client.oClub.create({
          data: {
            ...clubData,
            ExtId: BigInt(club.id),
          },
        });
        added++;
      }
    }

    // Fetch logos in the background — fire-and-forget so the mutation returns immediately.
    // Always fetches from prod-Eventor (test-Eventor doesn't host logos; org IDs are shared).
    void (async () => {
      try {
        await ensureLogoTable(client);
        const existingLogos = await client.oxygen_club_logo.findMany({
          select: { EventorId: true },
        });
        const existingLogoIds = new Set(existingLogos.map((l) => l.EventorId));

        // Also check global table to avoid re-fetching already known logos
        const mainConn = await getMainDbConnection();
        let globalLogoIds: Set<number>;
        try {
          await ensureClubDbTable(mainConn);
          const [rows] = await mainConn.execute(
            "SELECT EventorId FROM oxygen_club_db WHERE SmallLogoPng IS NOT NULL",
          );
          globalLogoIds = new Set((rows as { EventorId: number }[]).map((r) => r.EventorId));
        } finally {
          await mainConn.end();
        }

        const clubIdsNeedingLogos = allClubs
          .filter((c) => c.id > 0 && !existingLogoIds.has(c.id) && !globalLogoIds.has(c.id))
          .map((c) => c.id);

        const BATCH = 20;
        for (let i = 0; i < clubIdsNeedingLogos.length; i += BATCH) {
          const batch = clubIdsNeedingLogos.slice(i, i + BATCH);
          const results = await Promise.all(
            batch.map(async (orgId) => {
              const [small, large] = await Promise.all([
                fetchClubLogo(orgId, apiKey, "SmallIcon"),
                fetchClubLogo(orgId, apiKey, "LargeIcon"),
              ]);
              return { orgId, small, large };
            }),
          );
          for (const r of results) {
            if (r.small) {
              await client.oxygen_club_logo.upsert({
                where: { EventorId: r.orgId },
                create: {
                  EventorId: r.orgId,
                  SmallPng: r.small as any,
                  ...(r.large ? { LargePng: r.large as any } : {}),
                },
                update: {
                  SmallPng: r.small as any,
                  ...(r.large ? { LargePng: r.large as any } : {}),
                  UpdatedAt: new Date(),
                },
              });
              // Also write to global table for reuse across competitions
              const globalConn = await getMainDbConnection();
              try {
                await globalConn.execute(
                  `INSERT INTO oxygen_club_db (EventorId, Name, ShortName, CountryCode, SmallLogoPng, LargeLogoPng)
                   VALUES (?, '', '', '', ?, ?)
                   ON DUPLICATE KEY UPDATE SmallLogoPng = VALUES(SmallLogoPng), LargeLogoPng = VALUES(LargeLogoPng)`,
                  [r.orgId, r.small, r.large ?? null],
                );
              } finally {
                await globalConn.end();
              }
            }
          }
        }
      } catch {
        // Non-critical — logos can be fetched on next sync
      }
    })();

    return { added, updated, total: allClubs.length };
  }),

  /**
   * Fetch members of a club from Eventor for autocomplete.
   * Cached in-memory per organisationId to avoid repeated API calls.
   */
  clubMembers: publicProcedure
    .input(z.object({
      organisationId: z.number().int().positive(),
      env: z.enum(["prod", "test"]).default("prod"),
    }))
    .query(async ({ input }) => {
      const { apiKey } = await requireApiKey(input.env);

      // Check in-memory cache
      // Include env in cache key if needed, or just clear cache on switch
      const cacheKey = `${input.env}:${input.organisationId}`;
      const cached = clubMemberCache.get(input.organisationId as any); // Type hack or fix cache
      if (cached && Date.now() - cached.fetchedAt < MEMBER_CACHE_TTL_MS) {
        return cached.members;
      }

      const members = await fetchCompetitors(
        apiKey,
        input.organisationId,
        input.env,
      );

      clubMemberCache.set(input.organisationId, {
        members,
        fetchedAt: Date.now(),
      });

      return members;
    }),

  /**
   * Download the full Eventor cached competitor database and store in MeOSMain.
   * Also collects all clubs from the data and stores them in oxygen_club_db.
   */
  syncRunnerDb: publicProcedure
    .input(z.object({ env: z.enum(["prod", "test"]).default("prod") }))
    .mutation(async ({ input }) => {
      const { apiKey } = await requireApiKey(input.env);

      // 1. Download and parse the full competitor list
      const competitors = await fetchCachedCompetitors(apiKey, input.env);

      const conn = await getMainDbConnection();
      try {
        await ensureRunnerDbTable(conn);
        await ensureClubDbTable(conn);

        // 2. Collect unique clubs from competitor data
        const clubMap = new Map<number, string>();
        for (const c of competitors) {
          if (c.clubEventorId > 0 && c.clubName) {
            clubMap.set(c.clubEventorId, c.clubName);
          }
        }

        // 3. Bulk-upsert clubs into oxygen_club_db
        const clubEntries = [...clubMap.entries()];
        const CLUB_CHUNK = 500;
        for (let i = 0; i < clubEntries.length; i += CLUB_CHUNK) {
          const chunk = clubEntries.slice(i, i + CLUB_CHUNK);
          const placeholders = chunk.map(() => "(?, ?)").join(", ");
          const values = chunk.flatMap(([id, name]) => [id, name]);
          await conn.execute(
            `INSERT INTO oxygen_club_db (EventorId, Name) VALUES ${placeholders}
           ON DUPLICATE KEY UPDATE Name = VALUES(Name)`,
            values,
          );
        }

        // 4. Also fetch the full club list from Eventor for clubs without competitors
        try {
          const allClubs = await fetchClubs(apiKey, input.env);
          const FULL_CLUB_CHUNK = 500;
          for (let i = 0; i < allClubs.length; i += FULL_CLUB_CHUNK) {
            const chunk = allClubs.slice(i, i + FULL_CLUB_CHUNK);
            const placeholders = chunk.map(() => "(?, ?, ?, ?)").join(", ");
            const values = chunk.flatMap((c) => [
              c.id,
              c.name,
              c.shortName || "",
              c.countryCode || "",
            ]);
            await conn.execute(
              `INSERT INTO oxygen_club_db (EventorId, Name, ShortName, CountryCode) VALUES ${placeholders}
             ON DUPLICATE KEY UPDATE Name = VALUES(Name), ShortName = VALUES(ShortName), CountryCode = VALUES(CountryCode)`,
              values,
            );
          }
        } catch {
          // Non-critical — competitor data already has club names
          console.warn("[RunnerDB] Failed to fetch full club list, continuing with competitor-embedded data");
        }

        // 5. Download logos for clubs that don't have them yet
        const [existingLogos] = await conn.execute<import("mysql2/promise").RowDataPacket[]>(
          "SELECT EventorId FROM oxygen_club_db WHERE SmallLogoPng IS NOT NULL",
        );
        const hasLogo = new Set(
          (existingLogos as { EventorId: number }[]).map((r) => r.EventorId),
        );

        let logosAdded = 0;
        const clubIdsNeedingLogos = clubEntries
          .map(([id]) => id)
          .filter((id) => !hasLogo.has(id));

        // Download logos in batches (don't overwhelm the server)
        for (const clubId of clubIdsNeedingLogos.slice(0, 200)) {
          try {
            const small = await fetchClubLogo(clubId, apiKey, "SmallIcon");
            if (small) {
              const large = await fetchClubLogo(clubId, apiKey, "LargeIcon");
              await conn.execute(
                `UPDATE oxygen_club_db SET SmallLogoPng = ?, LargeLogoPng = ? WHERE EventorId = ?`,
                [small, large, clubId],
              );
              logosAdded++;
            }
          } catch {
            // Skip individual logo failures
          }
        }

        // 6. Truncate and bulk-insert runners (skip entries without a valid ExtId)
        const validRunners = competitors.filter((c) => c.extId > 0);
        await conn.execute("TRUNCATE TABLE oxygen_runner_db");

        const CHUNK = 1000;
        for (let i = 0; i < validRunners.length; i += CHUNK) {
          const chunk = validRunners.slice(i, i + CHUNK);
          const placeholders = chunk
            .map(() => "(?, ?, ?, ?, ?, ?, ?)")
            .join(", ");
          const values = chunk.flatMap((c) => [
            c.extId,
            c.name,
            c.cardNo,
            c.clubEventorId,
            c.birthYear,
            c.sex,
            c.nationality,
          ]);
          await conn.execute(
            `INSERT INTO oxygen_runner_db (ExtId, Name, CardNo, ClubId, BirthYear, Sex, Nationality) VALUES ${placeholders}`,
            values,
          );
        }

        // 7. Store sync metadata
        await setSetting("runnerdb_last_sync", new Date().toISOString());
        await setSetting("runnerdb_runner_count", String(validRunners.length));
        await setSetting("runnerdb_club_count", String(clubMap.size));

        return {
          runners: validRunners.length,
          clubs: clubMap.size,
          logosAdded,
        };
      } finally {
        await conn.end();
      }
    }),

  /**
   * Search the global runner database by name or card number.
   */
  searchRunnerDb: publicProcedure
    .input(z.object({ query: z.string().min(2) }))
    .query(async ({ input }) => {
      const conn = await getMainDbConnection();
      try {
        await ensureRunnerDbTable(conn);
        await ensureClubDbTable(conn);

        const q = input.query.trim();
        const isNumeric = /^\d+$/.test(q);

        let rows: import("mysql2/promise").RowDataPacket[];
        if (isNumeric) {
          // Search by card number (exact or prefix)
          [rows] = await conn.execute<import("mysql2/promise").RowDataPacket[]>(
            `SELECT r.ExtId, r.Name, r.CardNo, r.ClubId, r.BirthYear, r.Sex, r.Nationality,
                    COALESCE(c.Name, '') as ClubName
             FROM oxygen_runner_db r
             LEFT JOIN oxygen_club_db c ON r.ClubId = c.EventorId
             WHERE CAST(r.CardNo AS CHAR) LIKE ?
             ORDER BY r.CardNo = ? DESC, r.Name
             LIMIT 15`,
            [`${q}%`, parseInt(q, 10)],
          );
        } else {
          // Search by name — split into words so "Gustav Bergman" matches "Bergman, Gustav"
          const words = q.split(/[\s,]+/).filter((w) => w.length > 0);
          if (words.length === 0) {
            rows = [];
          } else {
            const whereClauses = words.map(() => "r.Name LIKE ?");
            const params = words.map((w) => `%${w}%`);
            [rows] = await conn.execute<import("mysql2/promise").RowDataPacket[]>(
              `SELECT r.ExtId, r.Name, r.CardNo, r.ClubId, r.BirthYear, r.Sex, r.Nationality,
                      COALESCE(c.Name, '') as ClubName
               FROM oxygen_runner_db r
               LEFT JOIN oxygen_club_db c ON r.ClubId = c.EventorId
               WHERE ${whereClauses.join(" AND ")}
               ORDER BY r.Name
               LIMIT 15`,
              params,
            );
          }
        }

        return (rows as Record<string, unknown>[]).map((r) => ({
          extId: Number(r.ExtId),
          name: r.Name as string,
          cardNo: Number(r.CardNo),
          clubEventorId: Number(r.ClubId),
          clubName: r.ClubName as string,
          birthYear: Number(r.BirthYear),
          sex: r.Sex as string,
          nationality: r.Nationality as string,
        }));
      } finally {
        await conn.end();
      }
    }),

  /**
   * Look up a runner by exact SI card number in the global runner database.
   * Used to pre-fill registration form when an unknown card is detected.
   */
  lookupByCardNo: publicProcedure
    .input(z.object({ cardNo: z.number().int().positive() }))
    .query(async ({ input }) => {
      const conn = await getMainDbConnection();
      try {
        await ensureRunnerDbTable(conn);
        const [rows] = await conn.execute<import("mysql2/promise").RowDataPacket[]>(
          `SELECT r.ExtId, r.Name, r.CardNo, r.ClubId, r.BirthYear, r.Sex, r.Nationality,
                  COALESCE(c.Name, '') as ClubName, COALESCE(c.EventorId, 0) as ClubEventorId
           FROM oxygen_runner_db r
           LEFT JOIN oxygen_club_db c ON r.ClubId = c.EventorId
           WHERE r.CardNo = ?
           LIMIT 1`,
          [input.cardNo],
        );
        if (!rows.length) return null;
        const r = rows[0] as Record<string, unknown>;
        return {
          name: r.Name as string,
          cardNo: Number(r.CardNo),
          clubEventorId: Number(r.ClubEventorId || r.ClubId),
          clubName: r.ClubName as string,
          birthYear: Number(r.BirthYear),
          sex: r.Sex as string,
        };
      } finally {
        await conn.end();
      }
    }),

  /**
   * Get the status of the global runner database.
   */
  runnerDbStatus: publicProcedure.query(async () => {
    const lastSync = await getSetting("runnerdb_last_sync");
    const runnerCount = await getSetting("runnerdb_runner_count");
    const clubCount = await getSetting("runnerdb_club_count");

    return {
      lastSync,
      runnerCount: runnerCount ? parseInt(runnerCount, 10) : 0,
      clubCount: clubCount ? parseInt(clubCount, 10) : 0,
    };
  }),
});

// ─── Helpers ────────────────────────────────────────────────

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

/**
 * Derive ClassFee from the most common runner Fee in each class.
 * Runner Fee is centesimal (11000 = 110 SEK), ClassFee is whole units (110 = 110 SEK).
 */
async function deriveClassFees(
  client: Awaited<ReturnType<typeof getCompetitionClient>>,
): Promise<void> {
  const runners = await client.oRunner.findMany({
    where: { Removed: false, Fee: { gt: 0 } },
    select: { Class: true, Fee: true },
  });
  if (runners.length === 0) return;

  // Group fees by class
  const feesByClass = new Map<number, number[]>();
  for (const r of runners) {
    if (r.Class <= 0) continue;
    let arr = feesByClass.get(r.Class);
    if (!arr) { arr = []; feesByClass.set(r.Class, arr); }
    arr.push(r.Fee);
  }

  // For each class, find the mode (most common fee) and update ClassFee
  for (const [classId, fees] of feesByClass) {
    const counts = new Map<number, number>();
    for (const f of fees) counts.set(f, (counts.get(f) ?? 0) + 1);
    let modeFee = 0, maxCount = 0;
    for (const [fee, count] of counts) {
      if (count > maxCount) { modeFee = fee; maxCount = count; }
    }
    if (modeFee > 0) {
      const classFee = Math.round(modeFee / 100); // centesimal → whole units
      await client.oClass.update({
        where: { Id: classId },
        data: { ClassFee: classFee },
      });
    }
  }
}

/** Sync clubs referenced in entries into the database. Returns mapping from Eventor org ID to local club ID. */
async function syncClubsFromEntries(
  client: Awaited<ReturnType<typeof getCompetitionClient>>,
  entries: EventorEntry[],
  apiKey: string,
): Promise<{ mapping: Map<number, number>; added: number; updated: number }> {
  const existingClubs = await client.oClub.findMany({ where: { Removed: false } });
  const clubExtIdMap = new Map(
    existingClubs.filter((c) => Number(c.ExtId) > 0).map((c) => [Number(c.ExtId), c]),
  );

  const mapping = new Map<number, number>();
  let added = 0;
  let updated = 0;

  // Deduplicate orgs from entries
  const orgs = new Map<number, { name: string; shortName: string; country: string }>();
  for (const e of entries) {
    if (e.organisationId > 0 && !orgs.has(e.organisationId)) {
      orgs.set(e.organisationId, {
        name: e.organisationName,
        shortName: e.organisationShortName || "",
        country: e.organisationCountry || "",
      });
    }
  }

  for (const [orgId, org] of orgs) {
    const existing = clubExtIdMap.get(orgId);
    if (existing) {
      const needsUpdate =
        (existing.Name !== org.name && org.name) ||
        (org.country && existing.Nationality !== org.country) ||
        (org.shortName && existing.ShortName !== org.shortName.substring(0, 17));
      if (needsUpdate) {
        await client.oClub.update({
          where: { Id: existing.Id },
          data: {
            Name: org.name || existing.Name,
            ...(org.shortName ? { ShortName: org.shortName.substring(0, 17) } : {}),
            ...(org.country ? { Nationality: org.country.substring(0, 7) } : {}),
          },
        });
        updated++;
      }
      mapping.set(orgId, existing.Id);
    } else {
      const created = await client.oClub.create({
        data: {
          Name: org.name,
          ShortName: (org.shortName || org.name).substring(0, 17),
          ExtId: BigInt(orgId),
          ...(org.country ? { Nationality: org.country.substring(0, 7) } : {}),
        },
      });
      mapping.set(orgId, created.Id);
      added++;
    }
  }

  // Also map existing clubs that weren't in entries
  for (const c of existingClubs) {
    if (Number(c.ExtId) > 0 && !mapping.has(Number(c.ExtId))) {
      mapping.set(Number(c.ExtId), c.Id);
    }
  }

  // Fetch logos for new clubs truly in the background — fire-and-forget so sync
  // returns immediately regardless of how long logo fetching takes.
  // Always fetches from prod-Eventor: test-Eventor doesn't host logos but shares
  // the same organisation IDs as prod, so prod logos apply to both.
  void (async () => {
    try {
      await ensureLogoTable(client);
      const existingLogos = await client.oxygen_club_logo.findMany({
        select: { EventorId: true },
      });
      const existingLogoIds = new Set(existingLogos.map((l) => l.EventorId));

      // Also check the global club DB — logos stored there don't need re-fetching
      const mainConn = await getMainDbConnection();
      let globalLogoIds: Set<number>;
      try {
        await ensureClubDbTable(mainConn);
        const [rows] = await mainConn.execute(
          "SELECT EventorId FROM oxygen_club_db WHERE SmallLogoPng IS NOT NULL",
        );
        globalLogoIds = new Set((rows as { EventorId: number }[]).map((r) => r.EventorId));
      } finally {
        await mainConn.end();
      }

      const needLogos = [...orgs.keys()].filter(
        (id) => !existingLogoIds.has(id) && !globalLogoIds.has(id),
      );

      if (needLogos.length === 0) {
        // Copy any global logos into the local per-competition table so logoMap works
        const toImport = [...orgs.keys()].filter(
          (id) => !existingLogoIds.has(id) && globalLogoIds.has(id),
        );
        for (const orgId of toImport) {
          const globalConn = await getMainDbConnection();
          try {
            const [rows] = await globalConn.execute(
              "SELECT SmallLogoPng, LargeLogoPng FROM oxygen_club_db WHERE EventorId = ?",
              [orgId],
            );
            const row = (rows as Record<string, Buffer | null>[])[0];
            if (row?.SmallLogoPng) {
              await client.oxygen_club_logo.upsert({
                where: { EventorId: orgId },
                create: {
                  EventorId: orgId,
                  SmallPng: row.SmallLogoPng as any,
                  ...(row.LargeLogoPng ? { LargePng: row.LargeLogoPng as any } : {}),
                },
                update: {
                  SmallPng: row.SmallLogoPng as any,
                  ...(row.LargeLogoPng ? { LargePng: row.LargeLogoPng as any } : {}),
                  UpdatedAt: new Date(),
                },
              });
            }
          } finally {
            await globalConn.end();
          }
        }
        return;
      }

      // Logos not found anywhere — fetch from prod-Eventor (works for both prod and test
      // competitions because org IDs are identical across environments).
      const BATCH = 10;
      for (let i = 0; i < needLogos.length; i += BATCH) {
        const batch = needLogos.slice(i, i + BATCH);
        const logoResults = await Promise.all(
          batch.map(async (orgId) => {
            const [small, large] = await Promise.all([
              fetchClubLogo(orgId, apiKey, "SmallIcon"),
              fetchClubLogo(orgId, apiKey, "LargeIcon"),
            ]);
            return { orgId, small, large };
          }),
        );
        for (const lr of logoResults) {
          if (lr.small) {
            // Store in per-competition table
            await client.oxygen_club_logo.upsert({
              where: { EventorId: lr.orgId },
              create: {
                EventorId: lr.orgId,
                SmallPng: lr.small as any,
                ...(lr.large ? { LargePng: lr.large as any } : {}),
              },
              update: {
                SmallPng: lr.small as any,
                ...(lr.large ? { LargePng: lr.large as any } : {}),
                UpdatedAt: new Date(),
              },
            });
            // Also store in global table so future competitions (including test-Eventor)
            // can reuse without re-fetching.
            const globalConn = await getMainDbConnection();
            try {
              await globalConn.execute(
                `INSERT INTO oxygen_club_db (EventorId, Name, ShortName, CountryCode, SmallLogoPng, LargeLogoPng)
                 VALUES (?, '', '', '', ?, ?)
                 ON DUPLICATE KEY UPDATE SmallLogoPng = VALUES(SmallLogoPng), LargeLogoPng = VALUES(LargeLogoPng)`,
                [lr.orgId, lr.small, lr.large ?? null],
              );
            } finally {
              await globalConn.end();
            }
          }
        }
      }
    } catch {
      // Non-critical — logos can be fetched on next sync
    }
  })();

  return { mapping, added, updated };
}
