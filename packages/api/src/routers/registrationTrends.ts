import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, competitionProcedure } from "../trpc.js";
import {
  ensureEventorEntryHistoryTable,
  getMainDbConnection,
  getSetting,
} from "../db.js";
import { meosEntryToDate } from "../timeConvert.js";
import { eventorKeyStore } from "../eventorKeyStore.js";
import {
  fetchEntries,
  fetchEventsBroad,
  fetchEventMeta,
  EventorAuthError,
  type EventorEntry,
} from "../eventor.js";
import { type EventorEnvironment } from "@oxygen/shared";
import type { RowDataPacket } from "mysql2/promise";

// ─── Cache freshness ────────────────────────────────────────

/**
 * How long a cached comparison-event entry list is allowed to stay fresh
 * without re-fetching, when the event's start date is in the future.
 * Past events are cached indefinitely (their entry list is immutable
 * once Eventor has finalised the start list).
 */
const FUTURE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ─── Throttle ───────────────────────────────────────────────

/**
 * Eventor doesn't publish a hard rate limit but anecdotally throttles
 * around ~1 request/second per API key. Comparison-event fetches happen
 * in small batches (typically 1-5 events), so a serial 1 req/s queue
 * inside a single procedure call is safe and simple.
 */
let lastEventorFetchAt = 0;

async function throttleEventorCall(): Promise<void> {
  const now = Date.now();
  const wait = 1000 - (now - lastEventorFetchAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastEventorFetchAt = Date.now();
}

// ─── Helpers ────────────────────────────────────────────────

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

function parseEventDate(date: string): Date | null {
  if (!date) return null;
  const [y, m, d] = date.split("-").map((s) => parseInt(s, 10));
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

/**
 * Parse an Eventor event ID from either a bare integer string or a full
 * URL like `https://eventor.orientering.se/Events/Show/12345/...`.
 * Returns `null` if no plausible ID could be extracted.
 */
export function parseEventorEventId(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Bare integer
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    return n > 0 ? n : null;
  }
  // Eventor URL — case-insensitive Events/Show/ID pattern
  const m = trimmed.match(/\/(?:Events?\/Show|api\/event)\/(\d+)/i);
  if (m) {
    const n = parseInt(m[1], 10);
    return n > 0 ? n : null;
  }
  return null;
}

// MySQL DATETIME has no timezone; we store local time and read it back as
// local. The columns we read here were written by mysql2 driver, so they
// arrive as JavaScript Dates already in local interpretation. We re-emit
// them as ISO strings for the API boundary.
function rowDateToIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

// ─── Router ─────────────────────────────────────────────────

export const registrationTrendsRouter = router({
  /**
   * Registration timeline for the **current competition** — every runner
   * row that carries a non-zero EntryDate, returned as ISO timestamps so
   * the UI can bucket them however it likes (per day, per hour, cumulative,
   * normalised to days-before-event, etc.).
   *
   * Manual entries created via runner.create are stamped to "now" and so
   * appear in this timeline as well; isManual lets the UI distinguish
   * them from Eventor-imported entries if desired.
   */
  ownTimeline: competitionProcedure.query(async ({ ctx }) => {
    const client = ctx.db;
    const event = await client.oEvent.findFirst({
      where: { Removed: false },
      select: { Name: true, Date: true, ExtId: true },
    });
    if (!event) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "No competition is open.",
      });
    }

    const runners = await client.oRunner.findMany({
      where: { Removed: false, EntryDate: { gt: 0 } },
      select: {
        Class: true,
        EntryDate: true,
        EntryTime: true,
        EntrySource: true,
      },
    });

    const classes = await client.oClass.findMany({
      where: { Removed: false },
      select: { Id: true, Name: true, SortIndex: true },
      orderBy: [{ SortIndex: "asc" }, { Name: "asc" }],
    });

    const entries: { at: string; classId: number; isManual: boolean }[] = [];
    for (const r of runners) {
      const date = meosEntryToDate(r.EntryDate, r.EntryTime);
      if (!date) continue;
      entries.push({
        at: date.toISOString(),
        classId: r.Class,
        isManual: r.EntrySource === 0,
      });
    }
    entries.sort((a, b) => a.at.localeCompare(b.at));

    const totalRunners = await client.oRunner.count({
      where: { Removed: false },
    });

    return {
      event: {
        name: event.Name,
        date: event.Date,
        eventorEventId: Number(event.ExtId) || null,
      },
      classes: classes.map((c) => ({ id: c.Id, name: c.Name })),
      entries,
      totalRunners,
      datedCount: entries.length,
    };
  }),

  /**
   * Look up candidate "comparable" events from Eventor.
   *
   * `fromDate`/`toDate` may be provided directly, or a window of
   * +/- `daysAround` days around the current competition's date is used.
   * `organisationIds` and `classificationIds` are optional Eventor filters
   * (district org IDs are accepted by Eventor and yield events from any
   * club in that district).
   *
   * The currently-linked Eventor event (if any) is filtered out of the
   * returned list so users can't pick "their own" event for comparison.
   */
  findComparableEvents: competitionProcedure
    .input(
      z
        .object({
          fromDate: z.string().optional(),
          toDate: z.string().optional(),
          daysAround: z.number().int().positive().max(366).optional(),
          /**
           * Optional Eventor org IDs to filter by. Eventor accepts both
           * club and district IDs. When omitted, Eventor returns all
           * events in the date range that the API key can read — which
           * is the default the comparison feature wants, since the whole
           * point is finding *other* clubs' competitions.
           */
          organisationIds: z.array(z.number().int().positive()).optional(),
          classificationIds: z.array(z.number().int().positive()).optional(),
          search: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const client = ctx.db;
      const dbName = ctx.dbName;
      const env = ((await getSetting(`eventor_env_${dbName}`)) ??
        "prod") as EventorEnvironment;
      const apiKey = await eventorKeyStore.getKey(env);
      if (!apiKey) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Eventor API key for ${env} is not configured.`,
        });
      }

      const event = await client.oEvent.findFirst({
        where: { Removed: false },
        select: { Date: true, ExtId: true },
      });

      const ownEventDate = parseEventDate(event?.Date ?? "");
      const window = input?.daysAround ?? 14;
      const fromDate =
        input?.fromDate ??
        formatDate(ownEventDate ? addDays(ownEventDate, -window) : addDays(new Date(), -window));
      const toDate =
        input?.toDate ??
        formatDate(ownEventDate ? addDays(ownEventDate, window) : addDays(new Date(), window));

      let events;
      try {
        events = await fetchEventsBroad(
          apiKey,
          {
            fromDate,
            toDate,
            ...(input?.organisationIds && input.organisationIds.length > 0
              ? { organisationIds: input.organisationIds }
              : {}),
            ...(input?.classificationIds ? { classificationIds: input.classificationIds } : {}),
          },
          env,
        );
      } catch (err) {
        if (err instanceof EventorAuthError) {
          // Either the key was rotated/expired (re-validate via the
          // competition selector) or the key genuinely can't browse the
          // requested scope. Either way, the paste-by-ID flow still
          // works for any single event the key can read, so we surface
          // that as the recommended next step.
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "Eventor refused this lookup. Your API key may have expired (re-validate it from the competition selector), or it doesn't have permission to browse the requested scope. " +
              "You can still add specific competitions by their Eventor event ID using the field above.",
          });
        }
        throw err;
      }

      const ownEventorId = Number(event?.ExtId) || 0;
      const search = (input?.search ?? "").trim().toLowerCase();

      const filtered = events
        .filter((e) => e.eventId !== ownEventorId)
        .filter((e) => {
          if (!search) return true;
          return (
            e.name.toLowerCase().includes(search) ||
            e.organiserName.toLowerCase().includes(search)
          );
        })
        .sort((a, b) => a.date.localeCompare(b.date));

      return {
        events: filtered.map((e) => ({
          id: e.eventId,
          name: e.name,
          date: e.date,
          classificationId: e.classificationId,
          classification: e.classification,
          organiserName: e.organiserName,
          organiserId: e.organiserId,
        })),
        from: fromDate,
        to: toDate,
      };
    }),

  /**
   * Resolve a pasted Eventor event ID (or full URL like
   * `https://eventor.orientering.se/Events/Show/12345`) to lightweight
   * metadata so the picker can show the event's name + date before the
   * user adds it as a comparison series.
   *
   * Modelled as a mutation so the React UI can invoke it imperatively on
   * button click; the underlying call is read-only.
   *
   * This bypasses the org-scoped /api/events 403 limitation: any event
   * the API key can read via /api/event/{id} will resolve here.
   */
  lookupEventorEvent: competitionProcedure
    .input(z.object({ eventIdOrUrl: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const dbName = ctx.dbName;
      const env = ((await getSetting(`eventor_env_${dbName}`)) ??
        "prod") as EventorEnvironment;
      const apiKey = await eventorKeyStore.getKey(env);
      if (!apiKey) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Eventor API key for ${env} is not configured.`,
        });
      }

      const id = parseEventorEventId(input.eventIdOrUrl);
      if (!id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Could not parse an Eventor event ID from that input.",
        });
      }

      try {
        const info = await fetchEventMeta(apiKey, id, env);
        if (!info) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Eventor returned no event for ID ${id}.`,
          });
        }
        return {
          id,
          name: info.name,
          date: info.date,
          classificationId: info.classificationId,
          organiserName: info.organiserName,
        };
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        if (err instanceof EventorAuthError) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "Eventor refused that event lookup. Verify the event ID and that your API key can read it.",
          });
        }
        throw err;
      }
    }),

  /**
   * Pull the registration timeline for a set of comparison events from
   * the MeOSMain cache, filling any misses by calling the Eventor entries
   * endpoint (rate-limited to 1 req/s).
   *
   * Past events are cached indefinitely — their entry list is finalised
   * once the event has happened. Future events refresh after the
   * FUTURE_CACHE_TTL_MS window.
   */
  fetchComparison: competitionProcedure
    .input(
      z.object({
        eventIds: z.array(z.number().int().positive()).min(1).max(20),
        /**
         * Optional metadata for each event. Passing the real race date,
         * name, organiser and classification from the picker (where it
         * was already resolved from /api/events or /api/event/{id})
         * means writeCache stores the right `startDate` and the
         * cache-freshness check correctly distinguishes past from
         * future events. Without this, the cache falls back to
         * `firstEntryDate` as a placeholder, which is months off and
         * shifts the days-before-race chart axis.
         */
        eventMeta: z
          .array(
            z.object({
              id: z.number().int().positive(),
              startDate: z.string(),
              name: z.string().optional(),
              organiserName: z.string().optional(),
              classificationId: z.number().int().optional(),
            }),
          )
          .optional(),
        force: z.boolean().optional().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const dbName = ctx.dbName;
      const env = ((await getSetting(`eventor_env_${dbName}`)) ??
        "prod") as EventorEnvironment;
      const apiKey = await eventorKeyStore.getKey(env);
      if (!apiKey) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Eventor API key for ${env} is not configured.`,
        });
      }

      const metaById = new Map<
        number,
        {
          startDate: string;
          name?: string;
          organiserName?: string;
          classificationId?: number;
        }
      >();
      if (input.eventMeta) {
        for (const m of input.eventMeta) metaById.set(m.id, m);
      }

      const conn = await getMainDbConnection();
      try {
        await ensureEventorEntryHistoryTable(conn);

        const out: {
          eventId: number;
          meta: {
            name: string;
            startDate: string;
            classificationId: number;
            organiser: string;
            entryCount: number;
            fetchedAt: string;
          } | null;
          entries: { at: string; classId: number }[];
          fromCache: boolean;
          error?: string;
        }[] = [];

        for (const eventId of input.eventIds) {
          const cached = await readCache(conn, eventId);
          // Legacy rows written before fetchComparison received eventMeta
          // have an empty Name and a bogus StartDate (= first entry
          // timestamp). Treat them as a cache miss so they get rewritten
          // with the correct metadata on next fetch.
          const looksLegacy =
            cached?.meta && cached.meta.name === "";
          const isPast =
            cached?.meta?.startDate &&
            new Date(cached.meta.startDate).getTime() < Date.now();
          const fresh =
            cached?.meta &&
            !looksLegacy &&
            (isPast ||
              Date.now() - new Date(cached.meta.fetchedAt).getTime() <
                FUTURE_CACHE_TTL_MS);

          if (cached && fresh && !input.force) {
            out.push({
              eventId,
              meta: cached.meta,
              entries: cached.entries,
              fromCache: true,
            });
            continue;
          }

          try {
            await throttleEventorCall();
            const fetched = await fetchEntries(apiKey, eventId, env);
            const stored = await writeCache(
              conn,
              eventId,
              fetched,
              metaById.get(eventId) ?? null,
            );
            out.push({
              eventId,
              meta: stored.meta,
              entries: stored.entries,
              fromCache: false,
            });
          } catch (err) {
            out.push({
              eventId,
              meta: cached?.meta ?? null,
              entries: cached?.entries ?? [],
              fromCache: !!cached,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        return { events: out };
      } finally {
        await conn.end();
      }
    }),
});

// ─── Cache I/O ──────────────────────────────────────────────

interface CachedEvent {
  meta: {
    name: string;
    startDate: string;
    classificationId: number;
    organiser: string;
    entryCount: number;
    fetchedAt: string;
  };
  entries: { at: string; classId: number }[];
}

async function readCache(
  conn: import("mysql2/promise").Connection,
  eventId: number,
): Promise<CachedEvent | null> {
  const [metaRows] = await conn.execute<RowDataPacket[]>(
    `SELECT Name, DATE_FORMAT(StartDate, '%Y-%m-%d') AS StartDate, ClassificationId, Organiser, EntryCount, FetchedAt
     FROM oxygen_eventor_event_meta WHERE EventorEventId = ?`,
    [eventId],
  );
  if (metaRows.length === 0) return null;
  const m = metaRows[0] as Record<string, unknown>;

  const [entryRows] = await conn.execute<RowDataPacket[]>(
    `SELECT EntryClassId, EntryAt FROM oxygen_eventor_entry_history
     WHERE EventorEventId = ? ORDER BY EntryAt ASC, RowSeq ASC`,
    [eventId],
  );
  const entries = (entryRows as Record<string, unknown>[]).map((r) => ({
    at: rowDateToIso(r.EntryAt),
    classId: Number(r.EntryClassId) || 0,
  }));

  return {
    meta: {
      name: String(m.Name ?? ""),
      startDate: String(m.StartDate ?? ""),
      classificationId: Number(m.ClassificationId) || 0,
      organiser: String(m.Organiser ?? ""),
      entryCount: Number(m.EntryCount) || entries.length,
      fetchedAt: rowDateToIso(m.FetchedAt),
    },
    entries,
  };
}

async function writeCache(
  conn: import("mysql2/promise").Connection,
  eventId: number,
  fetched: EventorEntry[],
  meta: {
    startDate: string;
    name?: string;
    organiserName?: string;
    classificationId?: number;
  } | null,
): Promise<CachedEvent> {
  // Convert fetched entries to (Date, classId) tuples, dropping rows
  // without a parsable EntryDate (they wouldn't appear on the chart).
  const rows: { at: Date; classId: number }[] = [];
  for (const e of fetched) {
    const at = meosEntryToDate(e.entryDate, e.entryTime);
    if (!at) continue;
    rows.push({ at, classId: e.classId });
  }
  rows.sort((a, b) => a.at.getTime() - b.at.getTime());

  const fetchedAt = new Date();
  const eventName = meta?.name ?? "";
  const organiserName = meta?.organiserName ?? "";
  const classificationId = meta?.classificationId ?? 0;
  // Race date comes from the caller (resolved by the picker via
  // findComparableEvents / lookupEventorEvent). Falling back to the
  // first entry's timestamp would shift the chart's days-before-race
  // axis by however long registration was open, which is the bug we're
  // fixing here.
  const startDate =
    meta?.startDate ?? formatDate(rows[0]?.at ?? new Date());

  // Insert/upsert. With explicit metadata available, we now overwrite
  // every column on duplicate-key — older rows that were written with
  // a placeholder startDate will be corrected the next time the cache
  // refreshes.
  await conn.execute(
    `INSERT INTO oxygen_eventor_event_meta
       (EventorEventId, Name, StartDate, ClassificationId, Organiser, EntryCount, FetchedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       Name             = VALUES(Name),
       StartDate        = VALUES(StartDate),
       ClassificationId = VALUES(ClassificationId),
       Organiser        = VALUES(Organiser),
       EntryCount       = VALUES(EntryCount),
       FetchedAt        = VALUES(FetchedAt)`,
    [
      eventId,
      eventName,
      startDate,
      classificationId,
      organiserName,
      rows.length,
      fetchedAt,
    ],
  );

  await conn.execute(
    `DELETE FROM oxygen_eventor_entry_history WHERE EventorEventId = ?`,
    [eventId],
  );

  if (rows.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const placeholders = slice.map(() => "(?, ?, ?, ?)").join(", ");
      const values = slice.flatMap((r, idx) => [
        eventId,
        i + idx,
        r.classId,
        r.at,
      ]);
      await conn.execute(
        `INSERT INTO oxygen_eventor_entry_history
           (EventorEventId, RowSeq, EntryClassId, EntryAt)
         VALUES ${placeholders}`,
        values,
      );
    }
  }

  // Return the stored representation
  const stored = await readCache(conn, eventId);
  if (stored) return stored;
  return {
    meta: {
      name: eventName,
      startDate,
      classificationId,
      organiser: organiserName,
      entryCount: rows.length,
      fetchedAt: fetchedAt.toISOString(),
    },
    entries: rows.map((r) => ({ at: r.at.toISOString(), classId: r.classId })),
  };
}
