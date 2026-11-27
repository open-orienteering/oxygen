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
import {
  router,
  authedProcedure,
  adminProcedure,
  manageProcedure,
  raceOperateProcedure,
  assertNotNodeForward,
} from "../trpc.js";
import { getSetting, setSetting, prisma, sanitizeNameId, isReservedEventSlug } from "../db.js";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { getActiveLease } from "../sync/lease.js";
import { lockEventLeaseAndSync } from "../event-locks.js";
import { firstFreeEventSlug, yearOf } from "../event-slug.js";
import {
  asClassSnapshot,
  asRunnerSnapshot,
  clampInt32,
  makeCardNoClaimer,
  normalizeCardNo,
  planClassSync,
  planRunnerSync,
  type ClassPlan,
  type ExistingClass,
  type ExistingRunner,
  type RunnerCreate,
  type RunnerPlan,
} from "../eventor-merge.js";
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
  mergePunchesInCardOrder,
  matchPunchesToCourse,
  computeClassPlacements,
  type ParsedPunch,
  RunnerStatus,
} from "@oxygen/shared";
import { toAbsolute, toRelativeWrapped, zeroTimeForResults, hasStartedByClock, eventNowDs } from "../timeConvert.js";
import { resolveCourseExpectedPositions } from "./course.js";
import { reconcileVariants } from "../variants.js";
import { pickRunnerCard } from "../cardLink.js";
import type {
  EventorEnvironment,
  RunnerStatusValue,
} from "@oxygen/shared";
import {
  upsertClubDirectoryEntries,
  upsertRunnerDirectoryEntries,
} from "../runner-directory-sync.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Interactive-transaction limits (as events.ts ingest): a sync/import is many writes. */
const SYNC_TX_OPTIONS = { timeout: 60_000, maxWait: 10_000 } as const;
/** `events.zero_time` default (09:00). */
const DEFAULT_ZERO_TIME = 324000;
const IMPORT_TX_OPTIONS = { timeout: 120_000, maxWait: 10_000 } as const;

/**
 * The cloud is the only writer of a leased-out event, and this sync is not
 * journaled, so a venue would never see its writes (review API-08): any active
 * lease refuses it, the holder's included. `pushResults` / `pushStartList`
 * only read the event and stay available.
 */
async function refuseWhileCheckedOut(
  db: PrismaClient | Prisma.TransactionClient,
  eventId: bigint,
): Promise<void> {
  if (await getActiveLease(db, eventId)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "EVENT_CHECKED_OUT: this event is checked out to a venue. Check it in before syncing from Eventor.",
    });
  }
}

function emptyResponse(what: string): TRPCError {
  return new TRPCError({
    code: "PRECONDITION_FAILED",
    message: `EVENTOR_EMPTY_RESPONSE: Eventor returned an empty ${what} for an event that has runners here. Nothing was changed.`,
  });
}

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

// Card-number helpers live with the merge rules (src/eventor-merge.ts); the
// router re-exports them for its callers and tests.
export { normalizeCardNo, makeCardNoClaimer };

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

  const valid = [
    ...new Map(
      clubs
        .filter((c) => c.id && c.name)
        .map((c) => [
          c.id,
          {
            eventorId: BigInt(c.id),
            name: c.name,
            shortName: (c.shortName || c.name).substring(0, 17),
            countryCode: (c.countryCode || "").substring(0, 3),
          },
        ] as const),
    ).values(),
  ];
  await upsertClubDirectoryEntries(db, valid);

  const added = valid.filter(
    (c) => !existingSet.has(c.eventorId.toString()),
  ).length;
  const updated = valid.length - added;
  return { added, updated };
}

// ── Sync / import helpers ──────────────────────────────────────────────────

type Db = PrismaClient | Prisma.TransactionClient;

async function deriveClassFees(db: Db, eventId: bigint): Promise<void> {
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

/** The local classes a sync plans against (live ones, as before). */
async function readClassesForSync(db: Db, eventId: bigint) {
  return db.class.findMany({
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
      eventorSnapshot: true,
    },
  });
}

type ClassRow = Awaited<ReturnType<typeof readClassesForSync>>[number];

function toExistingClasses(rows: ClassRow[]): ExistingClass[] {
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    eventorId: c.eventorId === null ? null : Number(c.eventorId),
    sortIndex: c.sortIndex,
    sex: c.sex,
    lowAge: c.lowAge,
    highAge: c.highAge,
    noTiming: c.noTiming,
    classType: c.classType,
    snapshot: asClassSnapshot(c.eventorSnapshot),
  }));
}

/**
 * Write a class plan: new classes, the changed fields and snapshots, and
 * Eventor's published course lengths. Returns Eventor class id → local id.
 */
async function applyClassPlan(
  db: Db,
  eventId: bigint,
  plan: ClassPlan,
  existing: ClassRow[],
  eventorClasses: ReadonlyArray<{ classId: number; courseLengthM?: number }>,
): Promise<Map<number, string>> {
  const classIdByEventorId = new Map<number, string>();
  for (const c of existing) {
    if (c.eventorId !== null) classIdByEventorId.set(Number(c.eventorId), c.id);
  }
  for (const u of plan.updates) {
    const d = u.data;
    await db.class.update({
      where: { id: u.id },
      data: {
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.sex !== undefined ? { sex: d.sex } : {}),
        ...(d.lowAge !== undefined ? { lowAge: d.lowAge } : {}),
        ...(d.highAge !== undefined ? { highAge: d.highAge } : {}),
        ...(d.noTiming !== undefined ? { noTiming: d.noTiming } : {}),
        ...(d.sortIndex !== undefined ? { sortIndex: d.sortIndex } : {}),
        ...(d.classType !== undefined ? { classType: d.classType } : {}),
        ...(u.snapshot ? { eventorSnapshot: u.snapshot as Prisma.InputJsonValue } : {}),
      },
    });
  }
  for (const c of plan.creates) {
    const created = await db.class.create({
      data: {
        eventId,
        eventorId: BigInt(c.eventorId),
        ...c.data,
        eventorSnapshot: c.snapshot as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    classIdByEventorId.set(c.eventorId, created.id);
  }

  // Eventor's IOF start list is authoritative for the published class
  // course length. Only update a shared course when every assigned class
  // reported the same positive value; conflicting values indicate a bad
  // class-course assignment and must not be resolved by last-write-wins.
  const courseOfClass = new Map(
    existing.filter((c) => c.eventorId !== null).map((c) => [Number(c.eventorId), c.courseId]),
  );
  const lengthsByCourseId = new Map<string, Set<number>>();
  for (const ec of eventorClasses) {
    const courseId = courseOfClass.get(ec.classId);
    if (courseId && (ec.courseLengthM ?? 0) > 0) {
      const lengths = lengthsByCourseId.get(courseId) ?? new Set();
      lengths.add(ec.courseLengthM!);
      lengthsByCourseId.set(courseId, lengths);
    }
  }
  for (const [courseId, lengths] of lengthsByCourseId) {
    if (lengths.size !== 1) continue;
    await db.course.updateMany({
      // Once a course has been edited in Oxygen, its freshly-derived
      // length supersedes Eventor's previously published snapshot
      // (`length_source = 'derived'`; NULL and 'file' are overwritten).
      where: {
        id: courseId,
        eventId,
        removed: false,
        OR: [{ lengthSource: null }, { lengthSource: { not: "derived" } }],
      },
      data: { lengthM: [...lengths][0] },
    });
  }
  return classIdByEventorId;
}

/** Eventor runner rows are written in chunks: one statement per 500 runners. */
const RUNNER_CHUNK = 500;

async function createRunners(
  db: Db,
  args: {
    eventId: bigint;
    eventorEventId: number;
    zeroTime: number;
    classIdByEventorId: ReadonlyMap<number, string>;
    creates: RunnerCreate[];
  },
): Promise<void> {
  const rows: Prisma.RunnerCreateManyInput[] = args.creates.map((c) => ({
    eventId: args.eventId,
    classId: c.classEventorId !== null ? (args.classIdByEventorId.get(c.classEventorId) ?? null) : null,
    clubName: c.clubName,
    eventorClubId: c.eventorClubId !== null ? BigInt(c.eventorClubId) : null,
    name: c.name,
    cardNo: c.cardNo,
    eventorPersonId: c.personId > 0 ? BigInt(c.personId) : null,
    eventorEntryId: c.eventorEntryId !== null ? BigInt(c.eventorEntryId) : null,
    entrySource: clampInt32(args.eventorEventId),
    birthYear: c.birthYear,
    sex: c.sex,
    nationality: c.nationality,
    entryDate: c.entryDate,
    entryTime: c.entryTime,
    // Eventor reports clock times; the columns hold ZeroTime-relative ones
    // (review RES-02). A start number is never taken from a result (EVT-04).
    startTime: toRelativeWrapped(c.startTime, args.zeroTime),
    finishTime: toRelativeWrapped(c.finishTime, args.zeroTime),
    status: c.status as Prisma.RunnerCreateManyInput["status"],
    bib: c.bib,
    feeCents: c.feeCents,
    paidCents: c.paidCents,
    taxableCents: c.taxableCents,
    rank: c.rank,
    eventorSnapshot: c.snapshot as Prisma.InputJsonValue,
  }));
  for (let i = 0; i < rows.length; i += RUNNER_CHUNK) {
    await db.runner.createMany({ data: rows.slice(i, i + RUNNER_CHUNK) });
  }
}

/** What an Eventor sync (or its preview) reports; the same shape for both. */
export interface EventorSyncResult {
  dryRun: boolean;
  classes: { added: number; updated: number; keptLocal: number; detailsIncomplete: boolean };
  clubs: { added: number; updated: number };
  runners: RunnerPlan["counts"];
  samples: { wouldCancel: string[]; heldBack: string[] };
  /** Ids of the runners cancelled (or, in a preview, to be); the apply call sends them back. */
  cancelIds: string[];
}

const SAMPLE_LIMIT = 20;

interface SyncPlan {
  classRows: ClassRow[];
  classPlan: ClassPlan;
  runnerPlan: RunnerPlan;
}

/**
 * Read the event's classes and runners and plan the sync against them. Pure
 * reads, so a preview and the real run (inside its transaction) compute the
 * same plan from the same code.
 */
async function planEventorSync(
  db: Db,
  args: {
    eventId: bigint;
    eventorEventId: number;
    eventorClasses: Awaited<ReturnType<typeof fetchEventClasses>>;
    entries: EventorEntry[];
    results: EventorResult[];
    clubNameByEventorId: ReadonlyMap<number, string>;
  },
): Promise<SyncPlan> {
  const classRows = await readClassesForSync(db, args.eventId);
  const classPlan = planClassSync({
    existing: toExistingClasses(classRows),
    eventor: args.eventorClasses,
  });

  const known = new Set<number>(args.eventorClasses.map((c) => c.classId));
  const eventorIdByLocalId = new Map<string, number | null>();
  for (const c of classRows) {
    if (c.eventorId !== null) known.add(Number(c.eventorId));
    eventorIdByLocalId.set(c.id, c.eventorId === null ? null : Number(c.eventorId));
  }

  const runners = await db.runner.findMany({
    where: {
      eventId: args.eventId,
      OR: [{ eventorPersonId: { not: null } }, { eventorEntryId: { not: null } }],
    },
    select: {
      id: true,
      name: true,
      cardNo: true,
      cardId: true,
      classId: true,
      eventorClubId: true,
      clubName: true,
      birthYear: true,
      sex: true,
      nationality: true,
      startTime: true,
      finishTime: true,
      status: true,
      removed: true,
      entrySource: true,
      entryDate: true,
      entryTime: true,
      feeCents: true,
      paidCents: true,
      taxableCents: true,
      rank: true,
      eventorPersonId: true,
      eventorEntryId: true,
      eventorSnapshot: true,
    },
  });
  const existing: ExistingRunner[] = runners.map((r) => ({
    id: r.id,
    eventorPersonId: r.eventorPersonId === null ? null : Number(r.eventorPersonId),
    eventorEntryId: r.eventorEntryId === null ? null : Number(r.eventorEntryId),
    removed: r.removed,
    name: r.name,
    cardNo: r.cardNo,
    cardId: r.cardId,
    classEventorId: r.classId ? (eventorIdByLocalId.get(r.classId) ?? null) : null,
    // Only a live local class with no Eventor id; a removed class is not "local".
    classLocalOnly: r.classId != null && eventorIdByLocalId.has(r.classId) && eventorIdByLocalId.get(r.classId) === null,
    eventorClubId: r.eventorClubId === null ? null : Number(r.eventorClubId),
    clubName: r.clubName,
    birthYear: r.birthYear,
    sex: r.sex,
    nationality: r.nationality,
    startTime: r.startTime,
    finishTime: r.finishTime,
    status: r.status,
    entrySource: r.entrySource,
    entryDate: r.entryDate,
    entryTime: r.entryTime,
    feeCents: r.feeCents,
    paidCents: r.paidCents,
    taxableCents: r.taxableCents,
    rank: r.rank,
    snapshot: asRunnerSnapshot(r.eventorSnapshot),
  }));

  // Card claims must respect every non-removed runner in the event —
  // including locally-registered ones without an Eventor person id —
  // or an update/create would trip the (event_id, card_no) unique index.
  const withCards = await db.runner.findMany({
    where: { eventId: args.eventId, removed: false, cardNo: { not: null } },
    select: { id: true, cardNo: true },
  });

  const runnerPlan = planRunnerSync({
    eventorEventId: args.eventorEventId,
    existing,
    cardOwners: withCards.map((r) => ({ ownerKey: r.id, cardNo: r.cardNo })),
    entries: args.entries,
    results: args.results,
    knownClassEventorIds: known,
    clubNameByEventorId: args.clubNameByEventorId,
  });
  return { classRows, classPlan, runnerPlan };
}

async function applyRunnerPlan(
  db: Db,
  args: {
    eventId: bigint;
    eventorEventId: number;
    zeroTime: number;
    plan: RunnerPlan;
    classIdByEventorId: ReadonlyMap<number, string>;
  },
): Promise<void> {
  const { plan, classIdByEventorId } = args;
  for (const u of plan.updates) {
    const d = u.data;
    await db.runner.update({
      where: { id: u.id },
      data: {
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.eventorPersonId !== undefined ? { eventorPersonId: BigInt(d.eventorPersonId) } : {}),
        ...(d.cardNo !== undefined ? { cardNo: d.cardNo } : {}),
        ...(d.classEventorId !== undefined
          ? { classId: classIdByEventorId.get(d.classEventorId) ?? undefined }
          : {}),
        ...(d.clubName !== undefined ? { clubName: d.clubName } : {}),
        ...(d.eventorClubId !== undefined ? { eventorClubId: BigInt(d.eventorClubId) } : {}),
        ...(d.birthYear !== undefined ? { birthYear: d.birthYear } : {}),
        ...(d.sex !== undefined ? { sex: d.sex } : {}),
        ...(d.nationality !== undefined ? { nationality: d.nationality } : {}),
        ...(d.entrySource !== undefined ? { entrySource: d.entrySource } : {}),
        ...(d.entryDate !== undefined ? { entryDate: d.entryDate } : {}),
        ...(d.entryTime !== undefined ? { entryTime: d.entryTime } : {}),
        ...(d.feeCents !== undefined ? { feeCents: d.feeCents } : {}),
        ...(d.paidCents !== undefined ? { paidCents: d.paidCents } : {}),
        ...(d.taxableCents !== undefined ? { taxableCents: d.taxableCents } : {}),
        ...(d.rank !== undefined ? { rank: d.rank } : {}),
        ...(d.status !== undefined ? { status: d.status as Prisma.RunnerUpdateInput["status"] } : {}),
        ...(u.snapshot ? { eventorSnapshot: u.snapshot as Prisma.InputJsonValue } : {}),
      },
    });
  }
  for (const r of plan.cancels) {
    await db.runner.update({
      where: { id: r.id },
      data: { status: "cancel", eventorSnapshot: r.snapshot as Prisma.InputJsonValue },
    });
  }
  for (const r of plan.heldBack) {
    await db.runner.update({
      where: { id: r.id },
      data: { eventorSnapshot: r.snapshot as Prisma.InputJsonValue },
    });
  }
  await createRunners(db, {
    eventId: args.eventId,
    eventorEventId: args.eventorEventId,
    zeroTime: args.zeroTime,
    classIdByEventorId,
    creates: plan.creates,
  });
}

function syncResult(
  dryRun: boolean,
  plan: SyncPlan,
  clubs: { added: number; updated: number },
): EventorSyncResult {
  return {
    dryRun,
    classes: {
      added: plan.classPlan.creates.length,
      updated: plan.classPlan.updates.filter((u) => Object.keys(u.data).length > 0).length,
      keptLocal: plan.classPlan.keptLocal,
      detailsIncomplete: plan.classPlan.detailsIncomplete,
    },
    clubs,
    runners: plan.runnerPlan.counts,
    samples: {
      wouldCancel: plan.runnerPlan.cancels.slice(0, SAMPLE_LIMIT).map((r) => r.name),
      heldBack: plan.runnerPlan.heldBack.slice(0, SAMPLE_LIMIT).map((r) => r.name),
    },
    cancelIds: plan.runnerPlan.cancels.map((r) => r.id),
  };
}

/** The clubs the entries and results mention, by Eventor id (no I/O). */
function collectClubs(
  entries: EventorEntry[],
  results: EventorResult[] = [],
): Map<number, EventorClub> {
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
  return seen;
}

function namesOf(clubs: ReadonlyMap<number, EventorClub>): Map<number, string> {
  return new Map([...clubs].map(([id, c]) => [id, c.name]));
}

/** How many of `clubs` the global directory has (updated) and lacks (added); reads only. */
async function countClubChanges(
  db: Db,
  clubs: EventorClub[],
): Promise<{ added: number; updated: number }> {
  const valid = new Set(clubs.filter((c) => c.id && c.name).map((c) => c.id));
  if (valid.size === 0) return { added: 0, updated: 0 };
  const have = await db.clubDirectory.findMany({
    where: { eventorId: { in: [...valid].map((id) => BigInt(id)) } },
    select: { eventorId: true },
  });
  const updated = have.length;
  return { added: valid.size - updated, updated };
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
  const seen = collectClubs(entries, results);

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

/**
 * The runner-directory sync is a ~9 MB Eventor download plus a bulk upsert;
 * one run at a time per process (a second caller gets CONFLICT).
 */
let runnerDbSyncRunning = false;

async function syncRunnerDbOnce(input: { env: "prod" | "test" }) {
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

  // 5. Upsert runner directory with one SQL statement per 1,000 rows.
  //    Keep the global table in place so readers never see it empty.
  const valid = [
    ...new Map(
      competitors
        .filter((c) => c.extId > 0)
        .map((c) => [c.extId, c] as const),
    ).values(),
  ];
  await upsertRunnerDirectoryEntries(
    db,
    valid.map((c) => ({
      eventorPersonId: BigInt(c.extId),
      name: c.name,
      cardNo: clampInt32(c.cardNo),
      eventorClubId: clampInt32(c.clubEventorId),
      birthYear: c.birthYear,
      sex: c.sex,
      nationality: c.nationality,
    })),
  );

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
}

export const eventorRouter = router({
  // ───────────── Key management ─────────────
  //
  // The API key is a club-wide credential (one row per environment in
  // oxygen_settings), so writing it is an instance-admin action that lives
  // on Settings → Eventor. Reading whether a key exists stays open to every
  // invited user: the import panel and the registration dialog gate their
  // UI on it. With AUTH_MODE=off both collapse to "anyone".

  validateKey: adminProcedure
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

  clearKey: adminProcedure
    .input(z.object({ env: z.enum(["prod", "test"]).default("prod") }))
    .mutation(async ({ input }) => {
      await eventorKeyStore.clearKey(input.env);
      return { success: true as const };
    }),

  keyStatus: authedProcedure
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

  getKey: authedProcedure
    .input(z.object({ env: z.enum(["prod", "test"]).default("prod") }))
    .query(async ({ input }) => {
      const apiKey = await eventorKeyStore.getKey(input.env);
      return { hasKey: !!apiKey, env: input.env };
    }),

  setKey: adminProcedure
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

  events: authedProcedure
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

  searchEvents: authedProcedure
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

  eventDetail: authedProcedure
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
   *
   * All or nothing: the slug is settled before any Eventor request, and the
   * event, its classes and every runner are written in one transaction, so a
   * failure half way leaves no event behind (review MC-13, EVT-09).
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
      assertNotNodeForward(ctx);
      const { apiKey } = await requireApiKey(input.env);
      const db = prisma();

      // 1. The slug and the duplicate check, before anything is fetched.
      const baseSlug = sanitizeNameId(input.eventName);
      if (isReservedEventSlug(baseSlug)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Slug "${baseSlug}" is reserved.`,
        });
      }
      const already = await db.event.findFirst({
        where: { eventorEventId: BigInt(input.eventId), eventorEnv: input.env, removed: false },
        select: { nameId: true },
      });
      if (already) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `This Eventor event is already imported as "${already.nameId}".`,
        });
      }
      // A name that a soft-deleted event still holds is taken too (the slug
      // is unique over deleted rows): the year, then the Eventor id.
      const year = yearOf(input.eventDate);
      const nameId = await firstFreeEventSlug(db, baseSlug, [
        ...(year ? [year] : []),
        String(input.eventId),
      ]);
      if (!nameId) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `An event with slug "${baseSlug}" already exists.`,
        });
      }

      // 2. Fetch from Eventor in parallel.
      const [classes, entries, results] = await Promise.all([
        fetchEventClasses(apiKey, input.eventId, input.env),
        fetchEntries(apiKey, input.eventId, input.env),
        fetchResults(apiKey, input.eventId, input.env),
      ]);

      // 3. Clubs go to the global directory (idempotent), outside the event's transaction.
      const { clubNameByEventorId } = await syncClubsFromEntries(
        apiKey,
        input.env,
        entries,
        results,
      );

      const classPlan = planClassSync({ existing: [], eventor: classes });
      const runnerPlan = planRunnerSync({
        firstImport: true,
        eventorEventId: input.eventId,
        existing: [],
        cardOwners: [],
        entries,
        results,
        knownClassEventorIds: new Set(classes.map((c) => c.classId)),
        clubNameByEventorId,
      });

      // 4. The event, its classes and all runners, in one transaction.
      const event = await db.$transaction(
        async (tx) => {
          const created = await tx.event.create({
            data: {
              nameId,
              name: input.eventName,
              date: new Date(input.eventDate),
              kind: eventKindFromClassification(input.classificationId),
              eventorEventId: BigInt(input.eventId),
              eventorEnv: input.env,
              organizerName: input.organiserName ?? "",
              organizerEventorId: input.organiserId ?? 0,
              // A run event's start times set its ZeroTime (an hour before the
              // earliest), so none lands on or before it (review RES-02).
              zeroTime: zeroTimeForResults(results.map((r) => r.startTime), DEFAULT_ZERO_TIME),
            },
            select: { id: true, nameId: true, zeroTime: true },
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
          if (ctx.user) {
            await grantSystemGroup(tx, {
              eventId: created.id,
              userId: ctx.user.id,
              groupId: SYSTEM_GROUP_IDS.eventAdmin,
              grantedBy: ctx.user.id,
            });
          }
          const classIdByEventorId = await applyClassPlan(tx, created.id, classPlan, [], classes);
          await createRunners(tx, {
            eventId: created.id,
            eventorEventId: input.eventId,
            zeroTime: created.zeroTime,
            classIdByEventorId,
            creates: runnerPlan.creates,
          });
          // Derive class fees from the mode entry fee per class.
          await deriveClassFees(tx, created.id);
          await tx.event.update({
            where: { id: created.id },
            data: { eventorLastSync: new Date() },
          });
          return created;
        },
        IMPORT_TX_OPTIONS,
      );

      return {
        nameId: event.nameId,
        eventId: Number(event.id),
        classCount: classes.length,
        clubCount: clubNameByEventorId.size,
        runnerCount: runnerPlan.creates.length,
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

  /**
   * Incremental sync — classes + clubs + runners from Eventor.
   *
   * Never undoes what the desk did (docs/system/eventor-sync.md): an Eventor
   * value is applied only when Eventor changed it since the last sync and the
   * local value is still the one that sync stored; times, status and start
   * numbers are never touched; a runner missing from Eventor is cancelled only
   * when nothing has happened to her locally. `dryRun` returns the same counts
   * without writing anything. Refused while the event is checked out to a
   * venue: the cloud is then not the writer and the sync is not journaled.
   */
  sync: manageProcedure
    .input(
      z
        .object({
          dryRun: z.boolean().default(false),
          /**
           * The runners the operator saw in the preview as "will be marked as
           * withdrawn". The apply may cancel fewer, never one that is not in
           * this list (EVENTOR_PREVIEW_CHANGED).
           */
          confirmCancelIds: z.array(z.string()).optional(),
        })
        .default({ dryRun: false }),
    )
    .mutation(async ({ ctx, input }): Promise<EventorSyncResult> => {
      const db = ctx.db;
      // An apply is always bound to a preview (an old client without the field
      // would otherwise apply blind).
      if (!input.dryRun && input.confirmCancelIds === undefined) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "EVENTOR_PREVIEW_REQUIRED: Preview the sync first, then apply it.",
        });
      }
      await refuseWhileCheckedOut(db, ctx.event.id);
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

      // 1. Everything from Eventor first: a failure here aborts before any write.
      const [eventorClasses, entries, results] = await Promise.all([
        fetchEventClasses(apiKey, eventorEventId, env),
        fetchEntries(apiKey, eventorEventId, env),
        fetchResults(apiKey, eventorEventId, env),
      ]);

      // 2. An empty answer is an odd response, not "everyone withdrew".
      if (entries.length === 0) {
        const live = await db.runner.count({
          where: {
            eventId: ctx.event.id,
            removed: false,
            OR: [{ eventorPersonId: { not: null } }, { eventorEntryId: { not: null } }],
            status: { not: "cancel" },
          },
        });
        if (live > 0) throw emptyResponse("entry list");
      }
      if (eventorClasses.length === 0) {
        const linked = await db.class.count({
          where: { eventId: ctx.event.id, removed: false, eventorId: { not: null } },
        });
        if (linked > 0) throw emptyResponse("class list");
      }

      // 3. A preview reads only: the directory is left alone and the club
      //    names come from the entries.
      if (input.dryRun) {
        const clubs = collectClubs(entries, results);
        const plan = await planEventorSync(db, {
          eventId: ctx.event.id,
          eventorEventId,
          eventorClasses,
          entries,
          results,
          clubNameByEventorId: namesOf(clubs),
        });
        return syncResult(true, plan, await countClubChanges(db, [...clubs.values()]));
      }

      const clubSync = await syncClubsFromEntries(apiKey, env, entries, results);

      // 4. One transaction: the lease is re-checked inside it, and a failure
      //    leaves the event as it was.
      const result = await db.$transaction(
        async (tx) => {
          // Ordered against a checkout: whoever takes this lock second sees the
          // other's result, so the lease is checked after taking it.
          await lockEventLeaseAndSync(tx, ctx.event.id);
          await refuseWhileCheckedOut(tx, ctx.event.id);
          const plan = await planEventorSync(tx, {
            eventId: ctx.event.id,
            eventorEventId,
            eventorClasses,
            entries,
            results,
            clubNameByEventorId: clubSync.clubNameByEventorId,
          });
          {
            const seen = new Set(input.confirmCancelIds ?? []);
            if (plan.runnerPlan.cancels.some((r) => !seen.has(r.id))) {
              throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message:
                  "EVENTOR_PREVIEW_CHANGED: Eventor's data changed since the preview; some runners would now be withdrawn that you did not see. Preview again.",
              });
            }
          }
          const classIdByEventorId = await applyClassPlan(
            tx,
            ctx.event.id,
            plan.classPlan,
            plan.classRows,
            eventorClasses,
          );
          await applyRunnerPlan(tx, {
            eventId: ctx.event.id,
            eventorEventId,
            zeroTime: ctx.event.zeroTime,
            plan: plan.runnerPlan,
            classIdByEventorId,
          });
          // A new entry, or one Eventor moved to another class, in a class on a
          // forked course is dealt a variant; one moved off it loses hers (F6b).
          await reconcileVariants(tx, ctx.event.id);
          await tx.event.update({
            where: { id: ctx.event.id },
            data: { eventorLastSync: new Date() },
          });
          return syncResult(false, plan, {
            added: clubSync.added,
            updated: clubSync.updated,
          });
        },
        SYNC_TX_OPTIONS,
      );
      return result;
    }),

  // ───────────── Global club / runner directory ─────────────

  /**
   * Pull the full Eventor competitor cache + club list into the
   * global runner_directory / club_directory tables. Fire-and-forget
   * logo fetch for clubs that lack one.
   */
  syncRunnerDb: manageProcedure
    .input(z.object({ env: z.enum(["prod", "test"]).default("prod") }))
    .mutation(async ({ input }) => {
      if (runnerDbSyncRunning) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Runner database sync already running",
        });
      }
      runnerDbSyncRunning = true;
      try {
        return await syncRunnerDbOnce(input);
      } finally {
        runnerDbSyncRunning = false;
      }
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

  runnerDbStatus: manageProcedure.query(async () => {
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

  searchRunnerDb: raceOperateProcedure
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

  lookupByCardNo: raceOperateProcedure
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

  clubMembers: raceOperateProcedure
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
  runnerDbDump: raceOperateProcedure.query(async () => {
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
          timeZone: true,
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
          // Backup-memory rows count only through their pushed mirror (RES-08).
          ctx.db.punch.findMany({
            where: { eventId: ctx.event.id, removed: false, source: { not: "backup_memory" } },
            orderBy: { time: "asc" },
          }),
        ],
      );

      const classById = new Map(classes.map((c) => [c.id, c]));
      const courseById = new Map(courses.map((c) => [c.id, c]));
      const cardById = new Map(cards.map((c) => [c.id, c]));
      const cardsByNo = new Map<number, typeof cards>();
      for (const c of cards) {
        const list = cardsByNo.get(c.cardNo) ?? [];
        list.push(c);
        cardsByNo.set(c.cardNo, list);
      }

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

        // The linked card only while it has the runner's number (API-11).
        const card = pickRunnerCard(
          r,
          r.cardId ? cardById.get(r.cardId) : null,
          cardsByNo.get(r.cardNo ?? -1) ?? [],
        );
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
        const merged = mergePunchesInCardOrder(cardPunches, freePunches);
        const fallbackStart = toAbsolute(r.startTime, event.zeroTime);
        const course = courseById.get(courseId);
        const matched = matchPunchesToCourse(merged, positions, fallbackStart, {
          orderMode: course?.orderMode ?? "ordered",
        });
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
              // Absolute: stored relative times are negative before
              // ZeroTime and would get no place (RES-05).
              startTime: toAbsolute(r.startTime, event.zeroTime),
              finishTime: toAbsolute(r.finishTime, event.zeroTime),
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
      const nowDs = eventNowDs(event);
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
          started:
            hasStartedByClock(r.startTime, event.zeroTime, nowDs) ||
            (matched?.matches.some((m) => m.status === "ok") ?? false) ||
            (r.cardNo != null && (freePunchesByCardNo.get(r.cardNo)?.length ?? 0) > 0),
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
  fetchEntryHistory: authedProcedure
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
