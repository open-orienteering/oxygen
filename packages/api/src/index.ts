// Mount the BigInt JSON polyfill before anything else loads — Prisma
// models surface BigInt PKs throughout the response pipeline.
import "./bigint-json.js";

import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  fastifyTRPCPlugin,
  type FastifyTRPCPluginOptions,
} from "@trpc/server/adapters/fastify";
import { appRouter, type AppRouter } from "./routers/index.js";
export type { AppRouter };
import { createContext } from "./trpc.js";
import { disconnectAll, prisma } from "./db.js";
import { liveResultsPusher, reconcileEnabledPushers } from "./liveresults.js";
import { onlineInputPuller, reconcileEnabledPullers } from "./online-input/puller.js";
import { startShipper, stopShipper } from "./sync/shipper.js";
import { registerVenueForwarder } from "./sync/venueForwarder.js";
import { SYNC_SECRET_HEADER } from "./sync/nodeIdentity.js";
import { registerBackupRoute } from "./backup.js";
import { registerMapTileRoutes } from "./map-tiles.js";
import { registerLiveloxTileProxy } from "./livelox-tile-proxy.js";
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
    bodyLimit: 50 * 1024 * 1024,
    maxParamLength: 500,
  });

  // CORS_ORIGINS (comma-separated) extends the dev defaults — a venue box
  // must allow the cloud-served PWA's HTTPS origin so stations on the LAN
  // can call it cross-origin (Chrome LNA lifts the mixed-content block).
  const extraOrigins = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  await server.register(cors, {
    origin: [
      "http://localhost:5173",
      "http://localhost:4173",
      "http://localhost:8080",
      ...extraOrigins,
    ],
    credentials: true,
    allowedHeaders: [
      "content-type",
      "x-competition-id",
      "x-event-id",
      SYNC_SECRET_HEADER,
    ],
  });

  // Venue role: cloud-owned mutations forward upstream before tRPC sees
  // them. No-op on the cloud / single-node deployments.
  registerVenueForwarder(server);

  await server.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: appRouter,
      createContext,
    } satisfies FastifyTRPCPluginOptions<AppRouter>["trpcOptions"],
  });

  const SERVER_START = new Date().toISOString();
  server.get("/health", async () => ({ status: "ok", startedAt: SERVER_START }));
  server.get("/api/version", async (_req, reply) =>
    reply.header("Cache-Control", "no-store").send({ startedAt: SERVER_START }),
  );

  registerBackupRoute(server);
  registerMapTileRoutes(server);
  registerLiveloxTileProxy(server);

  // Club logo endpoint — serves PNGs from the global club_directory.
  server.get<{ Params: { eventorId: string }; Querystring: { variant?: string } }>(
    "/api/club-logo/:eventorId",
    async (req, reply) => {
      const eventorId = parseInt(req.params.eventorId, 10);
      if (!eventorId || isNaN(eventorId)) {
        return reply.code(400).send({ error: "Invalid eventorId" });
      }
      const variant = req.query.variant === "large" ? "large" : "small";
      const row = await prisma().clubDirectory.findUnique({
        where: { eventorId: BigInt(eventorId) },
      });
      const data =
        variant === "large" && row?.largeLogoPng
          ? row.largeLogoPng
          : row?.smallLogoPng;
      if (!data || data.length === 0) {
        return reply.code(404).send({ error: "No logo" });
      }
      return reply
        .header("Content-Type", "image/png")
        .header("Cache-Control", "public, max-age=86400")
        .send(Buffer.from(data));
    },
  );

  // Background services. `liveResultsPusher` / `onlineInputPuller` are
  // process-wide registries; the reconcilers bring up one timer per
  // enabled event on boot so a restart doesn't silently drop pushes.
  liveResultsPusher();
  onlineInputPuller();
  void reconcileEnabledPushers().catch((err) =>
    console.error("[liveresults] reconcile failed:", err),
  );
  void reconcileEnabledPullers().catch((err) =>
    console.error("[online-input] reconcile failed:", err),
  );
  // Journal shipper — no-op unless SYNC_PEER_URL is configured (venue role).
  startShipper();

  await server.listen({ port: PORT, host: HOST });

  const shutdown = async () => {
    server.log.info("Shutting down");
    stopShipper();
    try {
      await server.close();
    } finally {
      await disconnectAll();
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
