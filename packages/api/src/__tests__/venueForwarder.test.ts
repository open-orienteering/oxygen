/**
 * Unit tests for the venue forwarder's request classification — which tRPC
 * requests a venue node sends upstream to the cloud (pivot Step 4).
 */

import http, { type IncomingHttpHeaders } from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SYNC_FORWARDED_HEADER, SYNC_NODE_ID_HEADER, SYNC_SECRET_HEADER } from "../sync/nodeIdentity.js";
import { _setIdTokenFetcher } from "../sync/googleIdToken.js";
import {
  registerVenueForwarder,
  trpcProcedurePaths,
  shouldForwardToCloud,
  isMixedCloudBatch,
  connectivityErrorBody,
} from "../sync/venueForwarder.js";
import { isCloudOwnedMutation } from "../sync/ownership.js";

describe("trpcProcedurePaths", () => {
  it("parses a single procedure", () => {
    expect(trpcProcedurePaths("/trpc/club.update")).toEqual(["club.update"]);
  });

  it("parses a batched request", () => {
    expect(trpcProcedurePaths("/trpc/club.update,club.create?batch=1")).toEqual([
      "club.update",
      "club.create",
    ]);
  });

  it("ignores non-trpc URLs", () => {
    expect(trpcProcedurePaths("/api/backup/event?name=x")).toEqual([]);
    expect(trpcProcedurePaths("/health")).toEqual([]);
  });
});

describe("isCloudOwnedMutation", () => {
  it("classifies directory / integration / lifecycle paths as cloud-owned", () => {
    expect(isCloudOwnedMutation("club.update")).toBe(true);
    expect(isCloudOwnedMutation("eventor.syncEntries")).toBe(true);
    expect(isCloudOwnedMutation("tracks.deleteRoute")).toBe(true);
    expect(isCloudOwnedMutation("liveresults.enable")).toBe(true);
    expect(isCloudOwnedMutation("event.create")).toBe(true);
    expect(isCloudOwnedMutation("event.delete")).toBe(true);
  });

  it("keeps the race-critical and ambiguous set local", () => {
    expect(isCloudOwnedMutation("runner.update")).toBe(false);
    expect(isCloudOwnedMutation("race.recordFinish")).toBe(false);
    expect(isCloudOwnedMutation("cardReadout.storeReadout")).toBe(false);
    expect(isCloudOwnedMutation("events.push")).toBe(false);
    expect(isCloudOwnedMutation("lease.checkin")).toBe(false);
    expect(isCloudOwnedMutation("event.setCardFee")).toBe(false);
    expect(isCloudOwnedMutation("onlineInput.enable")).toBe(false);
  });
});

describe("shouldForwardToCloud", () => {
  it("forwards only POSTed cloud-owned procedures", () => {
    expect(shouldForwardToCloud("POST", "/trpc/club.update")).toBe(true);
    expect(shouldForwardToCloud("POST", "/trpc/eventor.syncEntries?batch=1")).toBe(
      true,
    );
    // Queries stay local (stale copy is fine by the boundary rule).
    expect(shouldForwardToCloud("GET", "/trpc/club.list")).toBe(false);
    // Race-critical mutations execute locally on the venue.
    expect(shouldForwardToCloud("POST", "/trpc/runner.update")).toBe(false);
    // A mixed batch is never forwarded (it is refused, below).
    expect(
      shouldForwardToCloud("POST", "/trpc/club.update,runner.update?batch=1"),
    ).toBe(false);
    expect(shouldForwardToCloud("POST", "/health")).toBe(false);
  });

  it("forwards the map patch's writes and serves its reads locally (map-patches.md §3.4)", () => {
    expect(isCloudOwnedMutation("mapPatch.applyChange")).toBe(true);
    expect(isCloudOwnedMutation("mapPatch.setEnabled")).toBe(true);
    expect(isCloudOwnedMutation("mapPatch.promote")).toBe(true);
    expect(shouldForwardToCloud("POST", "/trpc/mapPatch.promote")).toBe(true);
    expect(shouldForwardToCloud("GET", "/trpc/mapPatch.promoteStatus")).toBe(false);
    expect(shouldForwardToCloud("POST", "/trpc/mapPatch.applyChange")).toBe(true);
    expect(shouldForwardToCloud("GET", "/trpc/mapPatch.get")).toBe(false);
  });

  it("forwards the GPS tracks' writes; reads are not forwarded (map-gps-tracks.md §1.3)", () => {
    for (const m of ["import", "update", "split", "remove", "markConverted"]) {
      expect(isCloudOwnedMutation(`mapTrack.${m}`)).toBe(true);
      expect(shouldForwardToCloud("POST", `/trpc/mapTrack.${m}`)).toBe(true);
    }
    expect(shouldForwardToCloud("GET", "/trpc/mapTrack.list")).toBe(false);
    expect(shouldForwardToCloud("GET", "/trpc/mapTrack.get?input=%7B%7D")).toBe(false);
    // `tracks.` (the replay router) and `mapTrack.` do not shadow each other.
    expect(isCloudOwnedMutation("mapTracks.import")).toBe(false);
    expect(isCloudOwnedMutation("tracks.import")).toBe(true);
  });

  it.each([
    ["courseMap", "saveLayout", "list"],
    ["mapTemplate", "update", "list"],
    ["layout", "autoSheets", "classOverrides"],
    ["graphics", "upload", "list"],
    ["courseObject", "update", "list"],
  ])("forwards %s.%s and serves %s locally (G18, map-storage.md §7.2)", (router, mutation, query) => {
    expect(isCloudOwnedMutation(`${router}.${mutation}`)).toBe(true);
    expect(shouldForwardToCloud("POST", `/trpc/${router}.${mutation}`)).toBe(true);
    expect(shouldForwardToCloud("GET", `/trpc/${router}.${query}`)).toBe(false);
  });

  it("keeps course and class writes local: `course.` is not `courseMap.` / `courseObject.`", () => {
    expect(isCloudOwnedMutation("course.update")).toBe(false);
    expect(isCloudOwnedMutation("course.presence")).toBe(false);
    expect(isCloudOwnedMutation("class.update")).toBe(false);
  });
});

describe("isMixedCloudBatch", () => {
  it("is a POSTed batch with cloud-owned and local procedures", () => {
    expect(isMixedCloudBatch("POST", "/trpc/course.presence,courseObject.update?batch=1")).toBe(true);
    expect(isMixedCloudBatch("POST", "/trpc/courseObject.update,courseMap.saveLayout?batch=1")).toBe(false);
    expect(isMixedCloudBatch("POST", "/trpc/runner.update,course.presence?batch=1")).toBe(false);
    expect(isMixedCloudBatch("GET", "/trpc/courseMap.list,course.list?batch=1")).toBe(false);
    expect(isMixedCloudBatch("POST", "/health")).toBe(false);
  });
});

describe("connectivityErrorBody", () => {
  it("shapes a tRPC error envelope, batched and unbatched, with the reason", () => {
    const single = connectivityErrorBody(["club.update"], false) as {
      error: { data: { code: string; path: string; reason: string } };
    };
    expect(single.error.data.code).toBe("PRECONDITION_FAILED");
    expect(single.error.data.path).toBe("club.update");
    expect(single.error.data.reason).toBe("CLOUD_UNREACHABLE");
    const mixed = connectivityErrorBody(["course.presence", "courseObject.update"], true, "MIXED_BATCH") as Array<{
      error: { message: string; data: { reason: string } };
    }>;
    expect(mixed.map((m) => m.error.data.reason)).toEqual(["MIXED_BATCH", "MIXED_BATCH"]);
    expect(mixed[0].error.message).toMatch(/nothing was run/);

    const batched = connectivityErrorBody(
      ["club.update", "club.create"],
      true,
    ) as Array<{ error: { data: { path: string } } }>;
    expect(batched).toHaveLength(2);
    expect(batched[1].error.data.path).toBe("club.create");
  });
});

// ── Forwarding on the wire (API-29 / MC-24 / SYNC-23) ───────────────────────

describe("registerVenueForwarder on the wire", () => {
  interface Seen { headers: IncomingHttpHeaders; url: string; body: string }
  const ENV_KEYS = ["NODE_ROLE", "SYNC_PEER_URL", "SYNC_SHARED_SECRET", "NODE_ID", "SYNC_GOOGLE_AUDIENCE", "AUTH_MODE", "AUTH_HEADER_NAME"] as const;
  const saved: Record<string, string | undefined> = {};
  let upstream: http.Server;
  let upstreamUrl: string;
  let seen: Seen[];
  let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  let venue: FastifyInstance;

  const jsonOk = (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ result: { data: { ok: true } } }));
  };

  async function startVenue(timeoutMs?: number): Promise<void> {
    venue = Fastify();
    registerVenueForwarder(venue, timeoutMs === undefined ? undefined : { timeoutMs });
    // The local handler a non-forwarded request would reach.
    venue.post("/trpc/*", async () => ({ local: true }));
    await venue.ready();
  }

  const post = (path = "/trpc/club.update") =>
    venue.inject({
      method: "POST",
      url: path,
      headers: { "content-type": "application/json", "x-event-id": "evt", "x-forwarded-email": "attacker@example.org", "x-goog-authenticated-user-email": "accounts.google.com:attacker@example.org" },
      payload: JSON.stringify({ name: "x" }),
    });

  beforeEach(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    seen = [];
    respond = jsonOk;
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen.push({ headers: req.headers, url: req.url ?? "", body });
        respond(req, res);
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    process.env.NODE_ROLE = "venue";
    process.env.SYNC_PEER_URL = upstreamUrl;
    process.env.SYNC_SHARED_SECRET = "s3cret";
    process.env.NODE_ID = "venue-7";
    delete process.env.SYNC_GOOGLE_AUDIENCE;
    delete process.env.AUTH_HEADER_NAME;
  });

  afterEach(async () => {
    _setIdTokenFetcher(null);
    await venue?.close();
    await new Promise<void>((r) => upstream.close(() => r()));
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("sends the node secret, the node id and the forwarded marker, and relays no client identity", async () => {
    await startVenue();
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: { data: { ok: true } } });
    expect(seen).toHaveLength(1);
    const h = seen[0].headers;
    expect(h[SYNC_SECRET_HEADER]).toBe("s3cret");
    expect(h[SYNC_NODE_ID_HEADER]).toBe("venue-7");
    expect(h[SYNC_FORWARDED_HEADER]).toBe("1");
    expect(h["x-event-id"]).toBe("evt");
    expect(h["x-forwarded-email"]).toBeUndefined();
    expect(h["x-goog-authenticated-user-email"]).toBeUndefined();
    expect(seen[0].body).toBe(JSON.stringify({ name: "x" }));
  });

  it.each([undefined, "", "cloud"])("a box whose NODE_ID is %j answers CLOUD_AUTH telling the operator to set it, without calling the cloud", async (id) => {
    if (id === undefined) delete process.env.NODE_ID;
    else process.env.NODE_ID = id;
    await startVenue();
    const res = await post();
    expect(res.statusCode).toBe(412);
    const body = res.json() as { error: { message: string; data: { reason: string; code: string } } };
    expect(body.error.data).toMatchObject({ code: "PRECONDITION_FAILED", reason: "CLOUD_AUTH" });
    expect(body.error.message).toMatch(/NODE_ID/);
    expect(seen).toHaveLength(0);
  });

  it("sends no caps header from a box with login off", async () => {
    await startVenue();
    await post();
    expect(seen[0].headers["x-oxygen-forwarded-caps"]).toBeUndefined();
  });

  it("sends no secret header when none is configured", async () => {
    delete process.env.SYNC_SHARED_SECRET;
    await startVenue();
    await post();
    expect(seen[0].headers[SYNC_SECRET_HEADER]).toBeUndefined();
    expect(seen[0].headers[SYNC_FORWARDED_HEADER]).toBe("1");
  });

  it("attaches the IAP bearer token when SYNC_GOOGLE_AUDIENCE is set", async () => {
    process.env.SYNC_GOOGLE_AUDIENCE = "aud-1";
    _setIdTokenFetcher(async (aud) => `token-for-${aud}`);
    await startVenue();
    await post();
    expect(seen[0].headers.authorization).toBe("Bearer token-for-aud-1");
  });

  it("answers CLOUD_AUTH, without a refresh, when the cloud answers with a redirect to a sign-in page", async () => {
    respond = (_req, res) => {
      res.writeHead(302, { location: "https://accounts.google.com/signin", "content-type": "text/html" });
      res.end("<html>sign in</html>");
    };
    await startVenue();
    // A map-write path so a refresh would be attempted on success.
    const res = await post("/trpc/courseMap.saveLayout");
    expect(res.statusCode).toBe(412);
    const body = res.json() as { error: { message: string; data: { reason: string; code: string } } };
    expect(body.error.data.reason).toBe("CLOUD_AUTH");
    expect(body.error.data.code).toBe("PRECONDITION_FAILED");
    expect(body.error.message).toMatch(/SYNC_SHARED_SECRET/);
    expect(seen).toHaveLength(1); // the redirect was not followed
  });

  it("answers CLOUD_AUTH for an HTML 200 and an HTML 403 from a proxy in front of the cloud", async () => {
    await startVenue();
    for (const status of [200, 403]) {
      respond = (_req, res) => {
        res.writeHead(status, { "content-type": "text/html" });
        res.end("<html>nope</html>");
      };
      const res = await post();
      expect(res.statusCode).toBe(412);
      expect((res.json() as { error: { data: { reason: string } } }).error.data.reason).toBe("CLOUD_AUTH");
    }
  });

  it("answers CLOUD_AUTH when the cloud itself refuses the node secret with a JSON 401", async () => {
    respond = (_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid or missing node sync secret", code: -32001, data: { code: "UNAUTHORIZED", httpStatus: 401 } } }));
    };
    await startVenue();
    const res = await post();
    expect(res.statusCode).toBe(412);
    expect((res.json() as { error: { data: { reason: string } } }).error.data.reason).toBe("CLOUD_AUTH");
  });

  it("answers CLOUD_UNREACHABLE when the cloud is silent past the timeout", async () => {
    respond = () => {
      /* never answers */
    };
    await startVenue(150);
    const res = await post();
    expect(res.statusCode).toBe(412);
    expect((res.json() as { error: { data: { reason: string } } }).error.data.reason).toBe("CLOUD_UNREACHABLE");
  });

  it("relays a tRPC JSON error with its status unchanged", async () => {
    const trpcError = { error: { message: "Missing capability event.manage", code: -32003, data: { code: "FORBIDDEN", httpStatus: 403 } } };
    respond = (_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify(trpcError));
    };
    await startVenue();
    const res = await post();
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(trpcError);
  });
});
