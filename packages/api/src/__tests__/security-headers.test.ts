import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerSecurityHeaders } from "../securityHeaders.js";

describe("registerSecurityHeaders", () => {
  it("adds nosniff to ordinary routes, JSON and errors alike, and keeps a route's own value", async () => {
    const app = Fastify();
    registerSecurityHeaders(app);
    app.get("/health", async () => ({ status: "ok" }));
    app.get("/boom", async () => {
      throw new Error("x");
    });
    app.get("/own", async (_req, reply) => reply.header("X-Content-Type-Options", "custom").send("x"));
    await app.ready();
    expect((await app.inject({ url: "/health" })).headers["x-content-type-options"]).toBe("nosniff");
    expect((await app.inject({ url: "/boom" })).headers["x-content-type-options"]).toBe("nosniff");
    expect((await app.inject({ url: "/nowhere" })).headers["x-content-type-options"]).toBe("nosniff");
    expect((await app.inject({ url: "/own" })).headers["x-content-type-options"]).toBe("custom");
    await app.close();
  });
});
