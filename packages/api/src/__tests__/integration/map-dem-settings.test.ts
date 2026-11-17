/**
 * Settings → Height data (docs/map-terrain.md §7.0b, §7.8): the router's
 * save and read-back without the password, admin only, the sealed row,
 * clear back to the environment, the `failed: auth` maps queued again by
 * a saved account, the club maps' states and retry, and *Test connection*
 * against the recorded fixture. No request leaves the process.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createHash, randomBytes } from "crypto";
import { mapDocument } from "@oxygen/shared";
import { TERRAIN_VERSION } from "@oxygen/shared/src/terrain/field/index.js";
import { makeCaller } from "../helpers/caller.js";
import { createTestEvent, type TestEventContext } from "../helpers/test-db.js";
import { FLAT, HILL, encodeTerrainDoc, sweref99 } from "../helpers/terrain-doc.js";
import { S, mapped, ring } from "@oxygen/shared/src/terrain/graph/__tests__/synthetic.js";
import { GLO_ORIGIN, LM_ORIGIN, STAC, demFixture, type DemFixture } from "../helpers/dem-fixture.js";
import { configureDemEngine, kickDemJobs, startDemJobEngine, stopDemJobEngine } from "../../map-store/dem-jobs.js";
import { deriveDemFields } from "../../map-store/dem-worker.js";
import { configureDemConfigSource, setDemProviders } from "../../map-store/dem-registry.js";
import { runLiveCheck } from "../../map-store/dem-live-check.js";
import { DEM_SETTING_KEYS } from "../../map-store/dem-settings.js";
import { demSettingsStore } from "../../map-store/dem-settings-store.js";
import { configureDemLiveCheck, startDemLiveCheck } from "../../map-store/dem-settings-service.js";
import { resetHeightfieldState } from "../../map-store/heightfield.js";
import { clearEventDocumentCaches } from "../../map-store/event-document.js";
import type { AuthUser } from "../../auth.js";

const suffix = randomBytes(4).toString("hex");
const EMAIL_DOMAIN = `@map-dem-settings-${suffix}.example`;
/** Obviously fake test values; the fixture's STAC accepts any credential. */
const USER = "test-geotorget-user";
const PASSWORD = `test-password-${suffix}`;
const ENV_CRED = "env-test-user:env-test-password";
const LM = "lantmateriet-2m";
const ENV_KEYS = ["MAP_DEM_PROVIDERS", "MAP_DEM_LANTMATERIET_AUTH", "MAP_DEM_LANTMATERIET_RESOLUTION_M"] as const;

let ctx: TestEventContext;
let fx: DemFixture;
let sourceHash = "";
const clubMaps: string[] = [];
let admin: AuthUser;
let member: AuthUser;
const savedEnv: Record<string, string | undefined> = {};

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const asAdmin = () => makeCaller(null, { authEnabled: true, authMode: "proxy", user: admin });
const asMember = () => makeCaller(null, { authEnabled: true, authMode: "proxy", user: member });

/** A club map whose one version is the document. */
async function clubMapOf(objects: Parameters<typeof encodeTerrainDoc>[0], name: string, georef?: Parameters<typeof encodeTerrainDoc>[3]): Promise<{ id: string; hash: string }> {
  const bytes = encodeTerrainDoc(objects, `${name}-${suffix}`, sourceHash, georef);
  const hash = sha(bytes);
  const { header } = mapDocument.readMapDocumentHeader(bytes);
  await ctx.db.mapDocument.create({
    data: { hash, bytes, sizeBytes: bytes.byteLength, formatVersion: 1, importerVersion: "test", libraryVersion: "none", sourceHash, header: JSON.parse(JSON.stringify({ ...header, symbols: undefined, strings: undefined })), report: {} },
  });
  const id = (await ctx.db.clubMap.create({ data: { name: `${name} ${suffix}` } })).id;
  await ctx.db.clubMapVersion.create({ data: { clubMapId: id, seq: 1, sourceHash, documentHash: hash } });
  clubMaps.push(id);
  return { id, hash };
}

const jobsOf = (hash: string) => ctx.db.mapDemJob.findMany({ where: { documentHash: hash, version: TERRAIN_VERSION } });

async function settle(hash: string) {
  for (let i = 0; i < 80; i++) {
    await kickDemJobs(ctx.db);
    const rows = await jobsOf(hash);
    if (rows.length > 0 && rows.every((r) => r.state !== "queued" && r.state !== "running")) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`DEM jobs of ${hash} did not settle`);
}

async function clearRows() {
  await ctx.db.setting.deleteMany({ where: { key: { startsWith: "map_dem." } } });
}

/** Everything a response may hold, as text, must not contain these. */
function expectNoSecret(value: unknown, extra: string[] = []) {
  const text = JSON.stringify(value);
  for (const s of [PASSWORD, Buffer.from(PASSWORD).toString("base64"), Buffer.from(`${USER}:${PASSWORD}`).toString("base64"), "env-test-password", ...extra]) expect(text).not.toContain(s);
}

beforeAll(async () => {
  ctx = await createTestEvent("map_dem_settings");
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  const src = Buffer.from(`dem-settings-source-${suffix}`);
  sourceHash = sha(src);
  await ctx.db.mapSource.create({ data: { fileHash: sourceHash, kind: "ocad", bytes: src, sizeBytes: src.byteLength, fileName: "dem.ocd" } });
  const a = await ctx.db.user.create({ data: { email: `admin${EMAIL_DOMAIN}`, displayName: "Test Admin", active: true, isAdmin: true } });
  const m = await ctx.db.user.create({ data: { email: `member${EMAIL_DOMAIN}`, displayName: "Test Member", active: true, isAdmin: false } });
  admin = { id: a.id, email: a.email, displayName: a.displayName, isAdmin: true, active: true };
  member = { id: m.id, email: m.email, displayName: m.displayName, isAdmin: false, active: true };
  configureDemEngine({ derive: async (d) => deriveDemFields(d) });
  await clearRows();
}, 120_000);

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  fx = demFixture();
  setDemProviders([]);
  // the server's source over the fixture's fetch: the saved rows over process.env
  configureDemConfigSource({ load: demSettingsStore.load, env: process.env, fetch: fx.fetch, warn: () => undefined });
  resetHeightfieldState();
  clearEventDocumentCaches();
  configureDemLiveCheck((d) => runLiveCheck({ ...d, fetch: fx.fetch, stac: STAC }));
});

afterEach(async () => {
  await clearRows();
});

afterAll(async () => {
  configureDemConfigSource(null);
  setDemProviders([]);
  configureDemEngine({});
  configureDemLiveCheck(null);
  for (const k of ENV_KEYS) if (savedEnv[k] === undefined) delete process.env[k];
  else process.env[k] = savedEnv[k];
  await ctx.cleanup();
  await ctx.db.clubMap.deleteMany({ where: { id: { in: clubMaps } } });
  await ctx.db.mapDocument.deleteMany({ where: { sourceHash } });
  await ctx.db.mapSource.deleteMany({ where: { fileHash: sourceHash } });
  await ctx.db.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
});

describe("the settings and the account (map-terrain.md §7.8)", () => {
  it("is off with nothing saved and nothing in the environment", async () => {
    const v = await asAdmin().demSettings.get();
    expect(v.status).toMatchObject({ providers: { lantmateriet: false, glo30: false, origin: "default" }, active: { lantmateriet: false, glo30: false }, resolutionM: 2, account: null, warnings: [] });
    expect(v.liveCheck).toBeNull();
  });

  it("saves the account and reads it back without the password; the row is sealed", async () => {
    const r = await asAdmin().demSettings.setAccount({ user: USER, password: PASSWORD });
    expect(r.view.status.account).toMatchObject({ saved: true, user: USER, origin: "saved", savedBy: "Test Admin", savedAt: expect.any(String) });
    expectNoSecret(r);
    const v = await asAdmin().demSettings.get();
    expect(v.status.account?.user).toBe(USER);
    expectNoSecret(v);
    const rows = await ctx.db.setting.findMany({ where: { key: { startsWith: "map_dem." } } });
    expect(rows.map((x) => x.key).sort()).toEqual([DEM_SETTING_KEYS.account, DEM_SETTING_KEYS.secretKey]);
    for (const row of rows) {
      expect(row.value).not.toContain(PASSWORD);
      expect(row.value).not.toContain(Buffer.from(PASSWORD).toString("base64"));
    }
    expect(JSON.parse(rows.find((x) => x.key === DEM_SETTING_KEYS.account)!.value!)).toMatchObject({ user: USER, secret: expect.stringMatching(/^v1:/) });
  });

  it("saves providers and resolution over the environment, and resets them to it", async () => {
    process.env.MAP_DEM_PROVIDERS = "glo30";
    process.env.MAP_DEM_LANTMATERIET_RESOLUTION_M = "1";
    expect((await asAdmin().demSettings.get()).status).toMatchObject({ providers: { glo30: true, origin: "environment" }, resolutionM: 1, resolutionOrigin: "environment", environment: { providers: true, resolution: true, account: false } });
    let v = await asAdmin().demSettings.save({ providers: { lantmateriet: false, glo30: false }, resolutionM: 2 });
    expect(v.status).toMatchObject({ providers: { lantmateriet: false, glo30: false, origin: "saved" }, resolutionM: 2, resolutionOrigin: "saved" });
    v = await asAdmin().demSettings.save({ providers: null, resolutionM: null });
    expect(v.status).toMatchObject({ providers: { glo30: true, origin: "environment" }, resolutionM: 1, resolutionOrigin: "environment" });
  });

  it("clears the account back to the environment's, keeping the password out", async () => {
    process.env.MAP_DEM_LANTMATERIET_AUTH = ENV_CRED;
    await asAdmin().demSettings.setAccount({ user: USER, password: PASSWORD });
    expect((await asAdmin().demSettings.get()).status.account?.origin).toBe("saved");
    const v = await asAdmin().demSettings.clearAccount();
    expect(v.status.account).toMatchObject({ user: "env-test-user", origin: "environment", savedAt: null });
    expectNoSecret(v);
    expect(await ctx.db.setting.findUnique({ where: { key: DEM_SETTING_KEYS.account } })).toBeNull();
  });

  it("refuses a malformed account without echoing it", async () => {
    await expect(asAdmin().demSettings.setAccount({ user: "a:b", password: PASSWORD })).rejects.toThrow();
    await expect(asAdmin().demSettings.setAccount({ user: USER, password: "" })).rejects.toThrow();
    try {
      await asAdmin().demSettings.setAccount({ user: "has space", password: PASSWORD });
    } catch (err) {
      expectNoSecret(String(err));
      expectNoSecret(JSON.stringify(err));
    }
    expect(await ctx.db.setting.findUnique({ where: { key: DEM_SETTING_KEYS.account } })).toBeNull();
  });

  it("is admin only, the queries too", async () => {
    const m = asMember().demSettings;
    const id = "00000000-0000-7000-8000-000000000000";
    for (const call of [() => m.get(), () => m.maps(), () => m.save({ providers: null }), () => m.setAccount({ user: USER, password: PASSWORD }), () => m.clearAccount(), () => m.retry({ clubMapId: id }), () => m.testConnection({ clubMapId: id })])
      await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await ctx.db.setting.count({ where: { key: { startsWith: "map_dem." } } })).toBe(0);
  });
});

describe("the club maps' DEM states and the queued retry (map-terrain.md §7.0b 7, §7.8)", () => {
  it("lists each club map off with no provider on", async () => {
    const { id } = await clubMapOf(FLAT, "off");
    const rows = await asAdmin().demSettings.maps();
    expect(rows.find((r) => r.clubMapId === id)).toMatchObject({ state: "disabled", job: null, retryable: false, liveCheck: "no-georeference" });
  });

  it("queues the failed: auth maps when an account is saved, and they complete", async () => {
    const { id, hash } = await clubMapOf(HILL, "auth", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    await asAdmin().demSettings.setAccount({ user: USER, password: "test-wrong-password" });
    await asAdmin().demSettings.save({ providers: { lantmateriet: true, glo30: false } });
    fx.mode.stac = 401;
    await asAdmin().demSettings.retry({ clubMapId: id });
    const [failed] = await settle(hash);
    expect(failed).toMatchObject({ provider: LM, state: "failed", reason: "auth", attempts: 1 });
    let row = (await asAdmin().demSettings.maps()).find((r) => r.clubMapId === id)!;
    expect(row).toMatchObject({ state: "failed", reason: "auth", providerId: LM, retryable: true, job: { attempts: 1 } });
    expectNoSecret(row, ["test-wrong-password"]);

    fx.mode.stac = "ok";
    const saved = await asAdmin().demSettings.setAccount({ user: USER, password: PASSWORD });
    expect(saved.requeued).toBeGreaterThanOrEqual(1);
    expect((await jobsOf(hash))[0]).toMatchObject({ attempts: expect.any(Number) });
    const [done] = await settle(hash);
    expect(done).toMatchObject({ provider: LM, state: "done", attempts: 1 });
    const auth = fx.requests.filter((r) => r.url.includes("/search?")).at(-1)!.authorization;
    expect(auth).toBe(`Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`);
    row = (await asAdmin().demSettings.maps()).find((r) => r.clubMapId === id)!;
    expect(row).toMatchObject({ state: "ready", retryable: false, liveCheck: null });
    expectNoSecret(row);
  });

  it("retries a failed map from its first attempt and refuses an unavailable one", async () => {
    const { id, hash } = await clubMapOf(HILL, "retry", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    await asAdmin().demSettings.setAccount({ user: USER, password: PASSWORD });
    await asAdmin().demSettings.save({ providers: { lantmateriet: true, glo30: false } });
    fx.mode.stac = 503;
    await asAdmin().demSettings.retry({ clubMapId: id });
    const [failed] = await settle(hash);
    expect(failed).toMatchObject({ state: "failed", reason: "http", nextAttemptAt: expect.any(Date) });
    fx.mode.stac = "ok";
    expect(await asAdmin().demSettings.retry({ clubMapId: id })).toEqual({ queued: true });
    expect((await jobsOf(hash))[0]).toMatchObject({ attempts: 0 });
    expect((await settle(hash))[0]).toMatchObject({ state: "done", attempts: 1 });

    // FLAT has no contours: unavailable, and a retry would end the same
    const flat = await clubMapOf(FLAT, "flat", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    await asAdmin().demSettings.retry({ clubMapId: flat.id });
    expect((await settle(flat.hash))[0]).toMatchObject({ state: "unavailable" });
    await expect(asAdmin().demSettings.retry({ clubMapId: flat.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await asAdmin().demSettings.save({ providers: { lantmateriet: false, glo30: false } });
    await expect(asAdmin().demSettings.retry({ clubMapId: id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

describe("over the window cap in the state list (map-terrain.md §7.0c answer 12)", () => {
  afterEach(() => configureDemEngine({ derive: async (d) => deriveDemFields(d) }));

  it("shows the level read on a ready map and the cap an over-cap ending hit; the retry still refuses it", async () => {
    await asAdmin().demSettings.setAccount({ user: USER, password: PASSWORD });
    await asAdmin().demSettings.save({ providers: { lantmateriet: true, glo30: false } });
    const under = await clubMapOf(HILL, "read-2m", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    await asAdmin().demSettings.retry({ clubMapId: under.id });
    expect((await settle(under.hash))[0]).toMatchObject({ state: "done" });

    // 2 m over the cap, 4 m under: read at 4 m
    configureDemEngine({ derive: async (d) => deriveDemFields(d), maxMosaicCells: 60_000 });
    const coarse = await clubMapOf(HILL, "read-4m", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    await asAdmin().demSettings.retry({ clubMapId: coarse.id });
    expect((await settle(coarse.hash))[0]).toMatchObject({ state: "done" });

    // over at both: over-cap, naming the window cells
    configureDemEngine({ derive: async (d) => deriveDemFields(d), maxMosaicCells: 10_000 });
    const over = await clubMapOf(HILL, "over-both", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    await asAdmin().demSettings.retry({ clubMapId: over.id });
    expect((await settle(over.hash))[0]).toMatchObject({ state: "unavailable", reason: "over-cap" });

    const rows = await asAdmin().demSettings.maps();
    expect(rows.find((r) => r.clubMapId === under.id)).toMatchObject({ state: "ready", providerId: LM, readAtM: 2, overCap: null });
    expect(rows.find((r) => r.clubMapId === coarse.id)).toMatchObject({ state: "ready", providerId: LM, readAtM: 4, overCap: null });
    const row = rows.find((r) => r.clubMapId === over.id)!;
    expect(row).toMatchObject({ state: "unavailable", reason: "over-cap", readAtM: null, overCap: "window-cells", retryable: false, job: { error: expect.stringMatching(/^window-cells: /) } });
    expectNoSecret(rows);
    await expect(asAdmin().demSettings.retry({ clubMapId: over.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("Test connection (map-terrain.md §7.0b 9, §7.6, §7.8)", () => {
  it("refuses without an account, before any request", async () => {
    const { id } = await clubMapOf(HILL, "no-account", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    await expect(asAdmin().demSettings.testConnection({ clubMapId: id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(fx.requests).toHaveLength(0);
  });

  it("runs the live check against the recorded fixture, stores and shows the result without the secret", async () => {
    const { id } = await clubMapOf(HILL, "live", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    await asAdmin().demSettings.setAccount({ user: USER, password: PASSWORD });
    // Lantmäteriet switched off: the check still runs on the saved account
    const { record, done } = await startDemLiveCheck(ctx.db, demSettingsStore, process.env, { clubMapId: id, by: "Test Admin" });
    expect(record).toMatchObject({ state: "queued", clubMapId: id, by: "Test Admin", startedAt: null });
    expect(["queued", "running"]).toContain((await asAdmin().demSettings.get()).liveCheck?.state);
    await expect(asAdmin().demSettings.testConnection({ clubMapId: id })).rejects.toMatchObject({ code: "CONFLICT" });
    await done;
    const v = await asAdmin().demSettings.get();
    expect(v.liveCheck).toMatchObject({ state: "done", mapName: `live ${suffix}`, startedAt: expect.any(String), finishedAt: expect.any(String), error: null });
    expect(v.liveCheck?.report?.verdict).toEqual({ rangeServed: true, credentialContained: true, profileRead: true, has2m: true, spreadHolds: true, pass: true });
    expect(v.liveCheck?.report?.range.status).toBe(206);
    expectNoSecret(v);
    expectNoSecret(await ctx.db.setting.findUnique({ where: { key: DEM_SETTING_KEYS.liveCheck } }));
    expect(fx.requests.filter((r) => r.authorization).every((r) => new URL(r.url).hostname.endsWith("lantmateriet.se"))).toBe(true);
  });

  it("stores an error, masked, when the check throws", async () => {
    const { id } = await clubMapOf(HILL, "throws", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    await asAdmin().demSettings.setAccount({ user: USER, password: PASSWORD });
    configureDemLiveCheck(async (d) => {
      throw new Error(`refused ${d.credential} (Basic ${Buffer.from(d.credential).toString("base64")})`);
    });
    const { done } = await startDemLiveCheck(ctx.db, demSettingsStore, process.env, { clubMapId: id, by: null });
    await done;
    const v = await asAdmin().demSettings.get();
    expect(v.liveCheck).toMatchObject({ state: "error", error: expect.stringContaining("refused") });
    expectNoSecret(v);
  });

  it("refuses a map without a georeference and one over the 1 m window cap", async () => {
    await asAdmin().demSettings.setAccount({ user: USER, password: PASSWORD });
    const plain = await clubMapOf(HILL, "no-georef");
    await expect(asAdmin().demSettings.testConnection({ clubMapId: plain.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // 600 × 600 mm at 1:15 000: 36 M graph cells (under H4's cap), 81 M cells at 1 m (over 64 M)
    const big = await clubMapOf(mapped([5, 10, 15, 20].map((r) => ({ sym: S.contour, coords: ring(30, 30, r, 96) })), [0, 0, 600, 600]), "big", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    const row = (await asAdmin().demSettings.maps()).find((r) => r.clubMapId === big.id)!;
    expect(row.liveCheck).toBe("over-1m-cap");
    await expect(asAdmin().demSettings.testConnection({ clubMapId: big.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fx.requests).toHaveLength(0);
    expect((await asAdmin().demSettings.get()).liveCheck).toBeNull();
  });
});

describe("the account replaced while jobs wait or run (map-terrain.md §7.8)", () => {
  it("queues the failed: auth maps even with Lantmäteriet switched off", async () => {
    const { id, hash } = await clubMapOf(HILL, "auth-off", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    await asAdmin().demSettings.setAccount({ user: USER, password: "test-wrong-password" });
    await asAdmin().demSettings.save({ providers: { lantmateriet: true, glo30: false } });
    fx.mode.stac = 401;
    await asAdmin().demSettings.retry({ clubMapId: id });
    expect((await settle(hash))[0]).toMatchObject({ state: "failed", reason: "auth" });
    await asAdmin().demSettings.save({ providers: { lantmateriet: false, glo30: false } });
    const saved = await asAdmin().demSettings.setAccount({ user: USER, password: PASSWORD });
    expect(saved.requeued).toBeGreaterThanOrEqual(1);
    expect((await jobsOf(hash))[0]).toMatchObject({ state: "queued", attempts: 0, reason: null });
  });

  it("queues again a job refused on the account that was replaced while it ran", async () => {
    const { id, hash } = await clubMapOf(HILL, "auth-mid", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    await asAdmin().demSettings.setAccount({ user: USER, password: "test-wrong-password" });
    await asAdmin().demSettings.save({ providers: { lantmateriet: true, glo30: false } });
    // the STAC refuses the old account, and the new one is saved while that request is out
    const base = fx.fetch;
    let replaced = false;
    configureDemConfigSource({
      load: demSettingsStore.load, env: process.env, warn: () => undefined,
      fetch: async (url, init) => {
        if (url.includes("/search?") && !replaced) {
          replaced = true;
          await demSettingsStore.setAccount({ user: USER, password: PASSWORD, savedBy: null });
          return new Response("{}", { status: 401 });
        }
        return base(url, init);
      },
    });
    await asAdmin().demSettings.retry({ clubMapId: id });
    const [done] = await settle(hash);
    expect(replaced).toBe(true);
    expect(done).toMatchObject({ state: "done", attempts: 1 });
  });

  it("the tick follows a provider switched on with none at its start", async () => {
    stopDemJobEngine();
    const { hash } = await clubMapOf(HILL, "tick", sweref99(GLO_ORIGIN.e, GLO_ORIGIN.n));
    startDemJobEngine(ctx.db, 50);
    try {
      await ctx.db.mapDemJob.create({ data: { documentHash: hash, provider: "glo30-30m", version: TERRAIN_VERSION, state: "queued" } });
      await new Promise((r) => setTimeout(r, 200));
      expect((await jobsOf(hash))[0]).toMatchObject({ state: "queued" });
      // saved straight into the row, as another instance's tab would: no kick here
      await demSettingsStore.saveProviders({ lantmateriet: false, glo30: true });
      await expect.poll(async () => (await jobsOf(hash))[0]?.state, { timeout: 20_000 }).toBe("done");
    } finally {
      stopDemJobEngine();
    }
  });

  it("withholds a report that holds the account", async () => {
    const { id } = await clubMapOf(HILL, "withheld", sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    await asAdmin().demSettings.setAccount({ user: USER, password: PASSWORD });
    configureDemLiveCheck(async (d) => ({ ...(await runLiveCheck({ ...d, fetch: fx.fetch, stac: STAC })), range: { status: 206, contentRange: d.credential, hops: [], error: null } }));
    const { done } = await startDemLiveCheck(ctx.db, demSettingsStore, process.env, { clubMapId: id, by: null });
    await done;
    const v = await asAdmin().demSettings.get();
    expect(v.liveCheck).toMatchObject({ state: "error", report: null, error: expect.stringContaining("withheld") });
    expectNoSecret(v);
  });
});
