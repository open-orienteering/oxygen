/**
 * `mapPatch.*` (docs/map-patches.md §3.2–3.3; slice G answer 1): the
 * event's corrections to its pinned map document. Reads are kiosk-readable
 * (the venue map draws the effective document); writes need
 * `courses.edit`, are not lease-guarded and not journaled — the patch is
 * cloud-owned non-critical data (08 §4.8), forwarded from a venue box
 * (`sync/ownership.ts`). Every write answers `{ version, patch }`;
 * `promote` adds the new club version and its job (§5, row G12a).
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { mapDocument } from "@oxygen/shared";
import { coursesEditProcedure, coursesViewProcedure, kioskOrCoursesViewProcedure, router } from "../trpc.js";
import { applyPatchChange, attachUnresolvedPatchOp, eventPatch, setPatchEnabled, type PatchDelivery } from "../map-store/patches.js";
import { PROMOTE_LABEL_MAX, promoteEventPatch, promoteStatus, type PromoteJobView, type PromoteResult } from "../map-store/promote.js";

const documentHashSchema = z.string().regex(/^[0-9a-f]{64}$/, "a 64-digit lower-case hex document hash");

export const mapPatchRouter = router({
  /** The patch keyed to the event's pin, or `{ version: "0", patch: null }` (§3.3). */
  get: kioskOrCoursesViewProcedure.query(({ ctx }): Promise<PatchDelivery> => eventPatch(ctx.db, ctx.event.id)),

  /**
   * Merge `put` / `remove` / `putSymbols` / `removeUnresolved` / `putUnresolved` per id (§1.5) into the patch keyed onto
   * `documentHash`, which must be the pin. A dormant row is re-resolved onto the pin first (§3.2 step 3, §4.4).
   */
  applyChange: coursesEditProcedure
    .input(z.object({ documentHash: documentHashSchema }).and(mapDocument.patchChangeSchema))
    .mutation(({ ctx, input }): Promise<PatchDelivery> => {
      const { documentHash, ...change } = input;
      return applyPatchChange(ctx.db, ctx.event.id, documentHash, change);
    }),

  /**
   * *Corrections*' fix (§4.3): unresolved entry `key`'s op put onto the pinned document's object `sourceIndex`
   * (a `target` entry), with `symbol` the user picked for a `symbol` entry or an add (G12b).
   */
  attachUnresolved: coursesEditProcedure
    .input(z.object({
      documentHash: documentHashSchema,
      key: z.string().min(1).max(200),
      sourceIndex: z.number().int().min(0).max(0xfffffffe).optional(),
      symbol: mapDocument.patchSymbolRefSchema.optional(),
    }))
    .mutation(({ ctx, input }): Promise<PatchDelivery> =>
      attachUnresolvedPatchOp(ctx.db, ctx.event.id, input.documentHash, input.key, input.sourceIndex, input.symbol)),

  /**
   * *Save corrections to the club map* (§5): the ops that apply to the pinned club version's document become its
   * next version's layer; they leave the event's patch when the import finishes. `courses.edit` and signed in (answer 9).
   */
  promote: coursesEditProcedure
    .input(z.object({ label: z.string().trim().min(1).max(PROMOTE_LABEL_MAX) }))
    .mutation(({ ctx, input }): Promise<PromoteResult> => {
      if (ctx.authEnabled && !ctx.user && !ctx.nodeForward) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to save corrections to the club map" });
      return promoteEventPatch(ctx.db, ctx.event.id, { label: input.label, userId: ctx.user?.id ?? null });
    }),

  /** The event's newest promote job (§5 answer 4: Map mode is read-only while it is queued or running), or null. */
  promoteStatus: coursesViewProcedure.query(({ ctx }): Promise<PromoteJobView | null> => promoteStatus(ctx.db, ctx.event.id)),

  /** The toggle (§1.4): false = every consumer draws the pinned document. */
  setEnabled: coursesEditProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ ctx, input }): Promise<PatchDelivery> => setPatchEnabled(ctx.db, ctx.event.id, input.enabled)),
});
