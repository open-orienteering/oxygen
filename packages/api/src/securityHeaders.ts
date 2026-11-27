/**
 * Headers every API response carries. No response is to be sniffed into
 * another type (an uploaded file served as `text/html`, CRS-003); a route that
 * sets the header itself keeps its value. There is no application-wide CSP yet
 * (docs/bugfixes/proxy-auth-followups.md).
 */
import type { FastifyInstance } from "fastify";

export function registerSecurityHeaders(server: FastifyInstance): void {
  server.addHook("onSend", async (_req, reply) => {
    if (!reply.hasHeader("x-content-type-options")) reply.header("X-Content-Type-Options", "nosniff");
  });
}
