/**
 * Registration Trends — entry-curve analytics for the active event,
 * with comparison against historical Eventor entries.
 *
 * Live data comes from the active event's `runners.entryDate` /
 * `entryTime` columns; comparison data is pulled from the
 * `eventor_event_meta` and `eventor_entry_history` caches that the
 * weekly Eventor sync populates. The fetch-from-Eventor side of the
 * comparison feature is staged behind `eventor.fetchEntryHistory` (to
 * land in the next pass — keeping this router pure-cache for now keeps
 * the dashboard and trends page green and is exactly what the offline
 * lab uses anyway).
 */

import { z } from "zod";
import { router, publicProcedure, eventProcedure } from "../trpc.js";
import { prisma } from "../db.js";

export interface RawEntry {
  /** ISO 8601 timestamp for when the entry was made in Eventor. */
  at: string;
  /** Class id within the source event (own classId or Eventor classId). */
  classId: number;
  /** Whether the entry came in via on-site form (true) or Eventor sync (false). */
  isManual?: boolean;
}

/**
 * Compose an ISO timestamp from MeOS-style EntryDate (YYYYMMDD) +
 * EntryTime (HH:MM:SS or seconds since midnight). Returns null if the
 * date is missing or unparseable.
 */
function entryToIso(entryDate: number, entryTime: number): string | null {
  if (!entryDate || entryDate < 19000101) return null;
  const y = Math.floor(entryDate / 10000);
  const m = Math.floor((entryDate % 10000) / 100);
  const d = entryDate % 100;
  if (y < 1900 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  // entryTime is stored as deciseconds since midnight in the new schema
  // (matches every other time-of-day column). Negative / zero → use noon
  // as a stable placeholder.
  const secs = entryTime > 0 ? Math.floor(entryTime / 10) : 12 * 3600;
  const h = Math.floor(secs / 3600);
  const mm = Math.floor((secs % 3600) / 60);
  const ss = secs % 60;
  return `${y.toString().padStart(4, "0")}-${m
    .toString()
    .padStart(2, "0")}-${d.toString().padStart(2, "0")}T${h
    .toString()
    .padStart(2, "0")}:${mm.toString().padStart(2, "0")}:${ss
    .toString()
    .padStart(2, "0")}.000Z`;
}

export const registrationTrendsRouter = router({
  /**
   * Entry-curve data for the *active* event. The web client renders
   * three things off this:
   *   - the dashboard sparkline (`entries` + `event.date`)
   *   - the main trends chart (entry timeline)
   *   - the class-filter chips (`classes`)
   *
   * Returned shape matches the legacy MeOS-era router so the existing
   * `lib/registration-trends.ts` series builder works unchanged.
   */
  ownTimeline: eventProcedure.query(async ({ ctx }) => {
    const event = await ctx.db.event.findUnique({
      where: { id: ctx.event.id },
      select: {
        name: true,
        date: true,
        eventorEventId: true,
      },
    });

    const runners = await ctx.db.runner.findMany({
      where: { eventId: ctx.event.id, removed: false },
      select: {
        entryDate: true,
        entryTime: true,
        entrySource: true,
        class: { select: { seq: true } },
      },
    });

    const classes = await ctx.db.class.findMany({
      where: { eventId: ctx.event.id, removed: false },
      orderBy: [{ sortIndex: "asc" }, { name: "asc" }],
      select: { seq: true, name: true },
    });

    const entries: RawEntry[] = [];
    for (const r of runners) {
      const at = entryToIso(r.entryDate, r.entryTime);
      if (!at) continue;
      entries.push({
        at,
        classId: r.class?.seq ?? 0,
        isManual: r.entrySource === 0,
      });
    }
    entries.sort((a, b) => a.at.localeCompare(b.at));

    return {
      event: {
        name: event?.name ?? "",
        date: event?.date.toISOString().slice(0, 10) ?? "",
        // BigInt → number via the BigInt.prototype.toJSON polyfill
        // installed in index.ts.
        eventorEventId: event?.eventorEventId ?? null,
      },
      classes: classes.map((c) => ({ id: c.seq, name: c.name })),
      entries,
      totalRunners: runners.length,
      datedCount: entries.length,
    };
  }),

  /**
   * Look up a specific Eventor event by numeric id or full Eventor URL
   * in the local cache.
   *
   * Web callers send `{ eventIdOrUrl }` as either:
   *   - a bare integer ("12345"), or
   *   - the full URL ("https://eventor.orientering.se/Events/Show/12345").
   *
   * Returns `{ id, name, date, organiserName, entryCount, fetchedAt }`.
   * Throws when the event isn't in the cache so the dialog can surface
   * a "sync first" message.
   */
  lookupEventorEvent: publicProcedure
    .input(z.object({ eventIdOrUrl: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const raw = input.eventIdOrUrl.trim();
      const urlMatch = raw.match(/\/Events\/Show\/(\d+)/i);
      const idStr = urlMatch ? urlMatch[1] : raw.replace(/[^\d]/g, "");
      const id = parseInt(idStr, 10);
      if (!id || !Number.isFinite(id)) {
        throw new Error(
          `Could not parse an Eventor event id from "${input.eventIdOrUrl}"`,
        );
      }
      const row = await prisma().eventorEventMeta.findUnique({
        where: { eventorEventId: id },
      });
      if (!row) {
        throw new Error(
          `Eventor event ${id} is not in the local cache yet. Sync registrations first.`,
        );
      }
      return {
        id: row.eventorEventId,
        name: row.name,
        date: row.startDate.toISOString().slice(0, 10),
        organiserName: row.organiser,
        entryCount: row.entryCount,
        classificationId: row.classificationId,
        fetchedAt: row.fetchedAt.toISOString(),
      };
    }),

  /**
   * Browse Eventor events near the active event for comparison.
   *
   * Inputs:
   *   - `daysAround`: ± window around today (default: any).
   *   - `classificationIds`: Eventor event-classification ids
   *     (championship / national / district / local / club / international).
   *
   * The cache is small (a few hundred rows at most) so we paginate by
   * `take: 50` ordered by date desc, then the dialog filters by name on
   * the client.
   */
  findComparableEvents: publicProcedure
    .input(
      z
        .object({
          daysAround: z.number().int().min(0).max(365).optional(),
          classificationIds: z.array(z.number().int()).optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const where: Record<string, unknown> = {};
      if (input?.classificationIds?.length) {
        where.classificationId = { in: input.classificationIds };
      }
      if (input?.daysAround && input.daysAround > 0) {
        const now = new Date();
        const lower = new Date(now);
        lower.setDate(now.getDate() - input.daysAround);
        const upper = new Date(now);
        upper.setDate(now.getDate() + input.daysAround);
        where.startDate = { gte: lower, lte: upper };
      }
      const rows = await prisma().eventorEventMeta.findMany({
        where,
        orderBy: { startDate: "desc" },
        take: 50,
      });
      return {
        events: rows.map((r) => ({
          id: r.eventorEventId,
          name: r.name,
          date: r.startDate.toISOString().slice(0, 10),
          organiserName: r.organiser,
          entryCount: r.entryCount,
          classificationId: r.classificationId,
        })),
      };
    }),

  /**
   * Pull entry-history for one or more Eventor events.
   *
   * Returns `{ events: [{ id, name, date, classes, entries }] }` — one
   * group per requested event id — so the RegistrationTrendsPage can
   * render an overlaid series per comparison event.
   *
   * Reads come from the existing `eventor_entry_history` cache; the
   * fetch-and-fill side of this lives in the eventor router and isn't
   * triggered here. Missing events come back as `null` entries so the
   * UI can prompt the user to sync them.
   */
  /**
   * Pull entry-history for one or more Eventor events.
   *
   * Returns `{ events: [{ eventId, entries, meta?, error? }] }` — one
   * group per requested event id. The shape mirrors the legacy router
   * so `RegistrationTrendsPage` doesn't need a follow-up patch.
   *
   * Reads come from the existing `eventor_entry_history` cache; the
   * fetch-and-fill side of this lives in the eventor router and isn't
   * triggered here. Missing events come back with `error: "missing"`
   * so the page can prompt the user to sync them.
   *
   * `eventMeta` is accepted but currently informational — the picker
   * sends its known race date so a follow-up sync can write it through
   * to the cache. We honour it on the response side so the picker
   * doesn't disagree with itself.
   */
  fetchComparison: publicProcedure
    .input(
      z.object({
        eventIds: z.array(z.number().int().positive()),
        eventMeta: z
          .array(
            z.object({
              id: z.number().int().positive(),
              startDate: z.string().optional(),
              name: z.string().optional(),
              organiserName: z.string().optional(),
            }),
          )
          .optional(),
        force: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const metaRows = await prisma().eventorEventMeta.findMany({
        where: { eventorEventId: { in: input.eventIds } },
      });
      const historyRows = await prisma().eventorEntryHistory.findMany({
        where: { eventorEventId: { in: input.eventIds } },
        orderBy: [{ eventorEventId: "asc" }, { rowSeq: "asc" }],
      });

      const byEvent = new Map<number, typeof historyRows>();
      for (const h of historyRows) {
        const arr = byEvent.get(h.eventorEventId) ?? [];
        arr.push(h);
        byEvent.set(h.eventorEventId, arr);
      }

      return {
        events: input.eventIds.map((eventId) => {
          const meta = metaRows.find((m) => m.eventorEventId === eventId);
          const override = input.eventMeta?.find((m) => m.id === eventId);
          const entries: RawEntry[] = (byEvent.get(eventId) ?? []).map((h) => ({
            at: h.entryAt.toISOString(),
            classId: h.entryClassId,
          }));
          const missing = !meta && entries.length === 0;
          return {
            eventId,
            entries,
            meta: {
              startDate:
                override?.startDate ??
                meta?.startDate.toISOString().slice(0, 10) ??
                "",
              name: override?.name ?? meta?.name ?? "",
              organiserName: override?.organiserName ?? meta?.organiser ?? "",
              classificationId: meta?.classificationId ?? 0,
              entryCount: meta?.entryCount ?? entries.length,
              fetchedAt: meta?.fetchedAt.toISOString() ?? null,
            },
            error: missing ? ("missing" as string) : null,
          };
        }),
      };
    }),

  /** Browse every cached Eventor event (used by trends-page picker UI). */
  listCachedEvents: publicProcedure.query(async () => {
    const rows = await prisma().eventorEventMeta.findMany({
      orderBy: { startDate: "desc" },
    });
    return rows.map((r) => ({
      eventorEventId: r.eventorEventId,
      name: r.name,
      startDate: r.startDate.toISOString().slice(0, 10),
      organiser: r.organiser,
      entryCount: r.entryCount,
      classificationId: r.classificationId,
      fetchedAt: r.fetchedAt.toISOString(),
    }));
  }),

  /** Raw entry history for a single Eventor event (debug / inspection). */
  entryHistory: publicProcedure
    .input(z.object({ eventorEventId: z.number().int() }))
    .query(async ({ input }) => {
      const rows = await prisma().eventorEntryHistory.findMany({
        where: { eventorEventId: input.eventorEventId },
        orderBy: { rowSeq: "asc" },
      });
      return rows.map((r) => ({
        rowSeq: r.rowSeq,
        entryClassId: r.entryClassId,
        entryAt: r.entryAt.toISOString(),
      }));
    }),
});
