import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, competitionProcedure } from "../trpc.js";
import { getSetting, setSetting } from "../db.js";
import {
    ensureCompetition,
    updateCompetitionMeta,
    liveResultsPusher,
    getLiveResultsPool,
    syncAll,
} from "../liveresults.js";

const CONFIG_SETTING_PREFIX = "liveresults_config_";

function configKey(nameId: string) {
    return `${CONFIG_SETTING_PREFIX}${nameId}`;
}

interface LiveResultsConfig {
    enabled: boolean;
    intervalSeconds: number;
    isPublic: boolean;
    country: string;
    tavid?: number;
}

async function getConfig(nameId: string): Promise<LiveResultsConfig> {
    const raw = await getSetting(configKey(nameId));
    if (!raw) {
        return { enabled: false, intervalSeconds: 30, isPublic: false, country: "SE" };
    }
    try {
        return JSON.parse(raw) as LiveResultsConfig;
    } catch {
        return { enabled: false, intervalSeconds: 30, isPublic: false, country: "SE" };
    }
}

async function saveConfig(nameId: string, config: LiveResultsConfig): Promise<void> {
    await setSetting(configKey(nameId), JSON.stringify(config));
}

export const liveresultsRouter = router({
    /**
     * Get current LiveResults config for the active competition.
     */
    getConfig: competitionProcedure.query(async ({ ctx }) => {
        const nameId = ctx.dbName;
        const config = await getConfig(nameId);
        const tavid = await getSetting(`liveresults_tavid_${nameId}`);
        return {
            ...config,
            tavid: tavid ? parseInt(tavid, 10) : null,
            publicUrl: tavid
                ? `https://liveresultat.orientering.se/followfull.php?comp=${tavid}`
                : null,
        };
    }),

    /**
     * Save LiveResults configuration. Also updates the LiveResults competition
     * metadata if a competition has already been created (tavid exists).
     */
    saveConfig: competitionProcedure
        .input(
            z.object({
                intervalSeconds: z.number().int().min(5).max(300).optional(),
                isPublic: z.boolean().optional(),
                country: z.string().length(2).optional(),
            }),
        )
        .mutation(async ({ ctx, input }) => {
            const nameId = ctx.dbName;
            const config = await getConfig(nameId);

            if (input.intervalSeconds !== undefined) config.intervalSeconds = input.intervalSeconds;
            if (input.isPublic !== undefined) config.isPublic = input.isPublic;
            if (input.country !== undefined) config.country = input.country;

            await saveConfig(nameId, config);

            // Update LiveResults metadata if competition already exists
            const tavidStr = await getSetting(`liveresults_tavid_${nameId}`);
            if (tavidStr) {
                await updateCompetitionMeta(parseInt(tavidStr, 10), {
                    isPublic: config.isPublic,
                    country: config.country,
                });
            }

            return { success: true };
        }),

    /**
     * Enable LiveResults sync.
     * Creates the competition in LiveResults if it doesn't exist yet,
     * then starts the interval pusher.
     */
    enable: competitionProcedure.mutation(async ({ ctx }) => {
        const nameId = ctx.dbName;

        const config = await getConfig(nameId);
        const tavid = await ensureCompetition(nameId);

        // Update meta with current config
        await updateCompetitionMeta(tavid, {
            isPublic: config.isPublic,
            country: config.country,
        });

        config.enabled = true;
        config.tavid = tavid;
        await saveConfig(nameId, config);

        liveResultsPusher.start(tavid, config.intervalSeconds, nameId);

        return {
            success: true,
            tavid,
            publicUrl: `https://liveresultat.orientering.se/followfull.php?comp=${tavid}`,
        };
    }),

    /**
     * Disable LiveResults sync (stops the interval timer).
     */
    disable: competitionProcedure.mutation(async ({ ctx }) => {
        const nameId = ctx.dbName;

        liveResultsPusher.stop();

        const config = await getConfig(nameId);
        config.enabled = false;
        await saveConfig(nameId, config);

        return { success: true };
    }),

    /**
     * Trigger an immediate sync (useful for testing).
     */
    pushNow: competitionProcedure.mutation(async ({ ctx }) => {
        const nameId = ctx.dbName;

        const tavidStr = await getSetting(`liveresults_tavid_${nameId}`);
        if (!tavidStr) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "LiveResults not enabled for this competition" });

        const tavid = parseInt(tavidStr, 10);
        const stats = await syncAll(tavid, nameId);
        return { success: true, stats };
    }),

    /**
     * Clear all remote LiveResults data (results, runners, splitcontrols)
     * for this competition. Useful when a tavid was reused and has stale data.
     * Optionally re-syncs fresh data immediately after clearing.
     */
    clearRemoteData: competitionProcedure.mutation(async ({ ctx }) => {
        const nameId = ctx.dbName;

        const tavidStr = await getSetting(`liveresults_tavid_${nameId}`);
        if (!tavidStr) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "LiveResults not enabled for this competition" });

        const tavid = parseInt(tavidStr, 10);
        const pool = await getLiveResultsPool();
        const conn = await pool.getConnection();
        try {
            await conn.execute("DELETE FROM results WHERE tavid = ?", [tavid]);
            await conn.execute("DELETE FROM runners WHERE tavid = ?", [tavid]);
            await conn.execute("DELETE FROM splitcontrols WHERE tavid = ?", [tavid]);
        } finally {
            conn.release();
        }

        const stats = await syncAll(tavid, nameId);
        return { success: true, cleared: true, resyncStats: stats };
    }),

    /**
     * Get current pusher status (running, last push time, errors, etc.).
     */
    getStatus: competitionProcedure.query(async ({ ctx }) => {
        const nameId = ctx.dbName;

        const status = liveResultsPusher.status;
        const tavidStr = await getSetting(`liveresults_tavid_${nameId}`);
        const tavid = tavidStr ? parseInt(tavidStr, 10) : null;

        return {
            ...status,
            tavid,
            publicUrl: tavid
                ? `https://liveresultat.orientering.se/followfull.php?comp=${tavid}`
                : null,
        };
    }),
});
