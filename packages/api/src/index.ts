import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  fastifyTRPCPlugin,
  type FastifyTRPCPluginOptions,
} from "@trpc/server/adapters/fastify";
import { appRouter, type AppRouter } from "./routers/index.js";
export type { AppRouter };
import { createContext } from "./trpc.js";
import { disconnectAll, getCompetitionClient, ensureLogoTable, getMainDbConnection, ensureClubDbTable } from "./db.js";
import "dotenv/config";

const PORT = parseInt(process.env.PORT ?? "3002", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

async function main() {
  const server = Fastify({
    logger: {
      level: "info",
      transport: {
        target: "pino-pretty",
        options: { translateTime: "HH:MM:ss Z", ignore: "pid,hostname" },
      },
    },
    bodyLimit: 50 * 1024 * 1024, // 50 MB — needed for OCAD map file uploads (base64)
    maxParamLength: 500, // tRPC httpBatchLink joins procedure names with commas in the URL path
  });

  // CORS for the frontend dev server
  await server.register(cors, {
    origin: ["http://localhost:5173", "http://localhost:4173", "http://localhost:8080"],
    credentials: true,
  });

  // tRPC handler
  await server.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: appRouter,
      createContext,
    } satisfies FastifyTRPCPluginOptions<AppRouter>["trpcOptions"],
  });

  // Health check + version info
  const SERVER_START = new Date().toISOString();
  server.get("/health", async () => ({ status: "ok", startedAt: SERVER_START }));
  server.get("/api/version", async (_req, reply) => {
    return reply
      .header("Cache-Control", "no-store")
      .send({ startedAt: SERVER_START });
  });

  // ─── Club Logo endpoint ────────────────────────────────────
  // Serves PNG images — checks global oxygen_club_db (MeOSMain) first,
  // then falls back to per-competition oxygen_club_logo table.
  // GET /api/club-logo/:eventorId?variant=small|large
  server.get<{
    Params: { eventorId: string };
    Querystring: { variant?: string };
  }>("/api/club-logo/:eventorId", async (req, reply) => {
    const eventorId = parseInt(req.params.eventorId, 10);
    if (!eventorId || isNaN(eventorId)) {
      return reply.code(400).send({ error: "Invalid eventorId" });
    }
    const variant = req.query.variant === "large" ? "large" : "small";

    // 1. Try global oxygen_club_db in MeOSMain
    try {
      const mainConn = await getMainDbConnection();
      try {
        await ensureClubDbTable(mainConn);
        const [rows] = await mainConn.execute(
          `SELECT SmallLogoPng, LargeLogoPng FROM oxygen_club_db WHERE EventorId = ?`,
          [eventorId],
        );
        const arr = rows as Record<string, unknown>[];
        if (arr.length > 0) {
          const data = (variant === "large" && arr[0].LargeLogoPng
            ? arr[0].LargeLogoPng
            : arr[0].SmallLogoPng) as Buffer | null;
          if (data && Buffer.isBuffer(data) && data.length > 0) {
            return reply
              .header("Content-Type", "image/png")
              .header("Cache-Control", "public, max-age=86400")
              .send(data);
          }
        }
      } finally {
        await mainConn.end();
      }
    } catch {
      // Global table might not exist yet — fall through
    }

    // 2. Fall back to per-competition oxygen_club_logo
    try {
      const client = await getCompetitionClient();
      await ensureLogoTable(client);
      const logo = await client.oxygen_club_logo.findUnique({
        where: { EventorId: eventorId },
      });

      if (!logo) {
        return reply.code(404).send({ error: "Logo not found" });
      }

      const data = variant === "large" && logo.LargePng
        ? logo.LargePng
        : logo.SmallPng;

      return reply
        .header("Content-Type", "image/png")
        .header("Cache-Control", "public, max-age=86400")
        .send(Buffer.from(data));
    } catch {
      return reply.code(404).send({ error: "Logo not found" });
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    server.log.info("Shutting down...");
    await disconnectAll();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await server.listen({ port: PORT, host: HOST });
    server.log.info(`Oxygen API server running at http://${HOST}:${PORT}`);
    server.log.info(`tRPC endpoint: http://${HOST}:${PORT}/trpc`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
