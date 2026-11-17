/**
 * `mapTrack.*` (docs/map-gps-tracks.md §1.2; row G24): an event's GPS
 * tracks. Every procedure — reads too — needs `courses.edit`, so tracks
 * are never delivered to a viewer or a kiosk key. The mutations are
 * cloud-owned (forwarded from a venue box, `@oxygen/shared`
 * `cloud-ownership.ts`), not lease-guarded and not journaled.
 */

import { z } from "zod";
import { coursesEditProcedure, router } from "../trpc.js";
import {
  MAX_EVENT_TRACKS,
  getTrack,
  importTracks,
  listTracks,
  markTracksConverted,
  removeTracks,
  splitTrackRow,
  updateTrack,
  type TrackMeta,
  type TrackWithPoints,
} from "../gps-tracks.js";

const trackId = z.string().uuid();
const rangeSchema = z.object({ start: z.number().int(), end: z.number().int() });

const importItemSchema = z.object({
  id: trackId.optional(),
  name: z.string().max(200).nullable(),
  sourceName: z.string().max(255),
  /** TrackPoints (§2.1), validated by hand in `gps-tracks.ts`: a capped track is 800 000 numbers. */
  points: z.unknown(),
  /** An average's passes: 2–200 distinct ids (distinctness checked in `gps-tracks.ts`, `TRACK_POINTS_INVALID`). */
  derivedFrom: z.array(trackId).min(2).max(MAX_EVENT_TRACKS).optional(),
  singlePass: z.array(rangeSchema).optional(),
});

/** A patch add-op id (`add:<uuid>`, `mapDocument.patchOpId`), or null to clear. */
const opIdSchema = z.string().regex(/^add:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "an add op id, add:<lower-case uuid>").nullable();

export const mapTrackRouter = router({
  /** Metadata in list order (`created_at`, `id`); never the points. */
  list: coursesEditProcedure.query(async ({ ctx }): Promise<{ tracks: TrackMeta[] }> => ({ tracks: await listTracks(ctx.db, ctx.event.id) })),

  /** One track with its points. */
  get: coursesEditProcedure
    .input(z.object({ id: trackId }))
    .query(({ ctx, input }): Promise<TrackWithPoints> => getTrack(ctx.db, ctx.event.id, input.id)),

  /** Tracks parsed on the device; caps 200 000 points a track, 200 tracks an event, 500 000 points a call. */
  import: coursesEditProcedure
    .input(z.object({ tracks: z.array(importItemSchema).min(1).max(MAX_EVENT_TRACKS) }))
    .mutation(async ({ ctx, input }): Promise<{ tracks: TrackMeta[] }> => ({
      tracks: await importTracks(ctx.db, ctx.event.id, ctx.user?.id ?? null, input.tracks),
    })),

  /** Name and trim `[start, end)` on the stored points. */
  update: coursesEditProcedure
    .input(
      z
        .object({ id: trackId, name: z.string().max(200).nullable().optional(), trim: rangeSchema.optional() })
        .refine((v) => v.name !== undefined || v.trim !== undefined, "name or trim"),
    )
    .mutation(({ ctx, input }): Promise<TrackMeta> => updateTrack(ctx.db, ctx.event.id, input.id, { name: input.name, trim: input.trim })),

  /** Replace the track with two parts sharing the point `index`. */
  split: coursesEditProcedure
    .input(z.object({ id: trackId, index: z.number().int(), ids: z.tuple([trackId, trackId]).optional() }))
    .mutation(async ({ ctx, input }): Promise<{ tracks: [TrackMeta, TrackMeta] }> => ({
      tracks: await splitTrackRow(ctx.db, ctx.event.id, input.id, input.index, input.ids),
    })),

  /** Delete the event's tracks among `ids`; unknown ids are ignored. */
  remove: coursesEditProcedure
    .input(z.object({ ids: z.array(trackId).min(1).max(MAX_EVENT_TRACKS) }))
    .mutation(async ({ ctx, input }): Promise<{ removed: number }> => ({ removed: await removeTracks(ctx.db, ctx.event.id, input.ids) })),

  /** Set or clear the patch op a track was converted into (G26). */
  markConverted: coursesEditProcedure
    .input(z.object({ marks: z.array(z.object({ id: trackId, opId: opIdSchema })).min(1).max(MAX_EVENT_TRACKS) }))
    .mutation(async ({ ctx, input }): Promise<{ tracks: TrackMeta[] }> => ({ tracks: await markTracksConverted(ctx.db, ctx.event.id, input.marks) })),
});
