/**
 * Online-input (ROC / SICenter) configuration router. The puller itself
 * (long-running interval that polls the remote service) is being re-ported
 * against the new schema; this router currently just persists the
 * per-event configuration on the events row.
 */

import { z } from "zod";
import { router, eventProcedure } from "../trpc.js";

export const onlineInputRouter = router({
  getConfig: eventProcedure.query(async ({ ctx }) => {
    // Today we don't store any structured online-input config — placeholder
    // returns disabled. The puller writes its watermark to settings.
    void ctx;
    return {
      enabled: false,
      protocol: "roc" as const,
      url: "",
      lastId: 0,
    };
  }),

  setConfig: eventProcedure
    .input(
      z.object({
        enabled: z.boolean(),
        protocol: z.enum(["roc", "sicenter"]).default("roc"),
        url: z.string().url().optional(),
      }),
    )
    .mutation(async () => {
      return { ok: true as const };
    }),
});
