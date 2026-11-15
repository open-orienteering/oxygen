import { afterEach, describe, expect, it } from "vitest";
import { demBaseFetch } from "../map-store/dem-providers.js";
import { configureDemConfigSource, demProviders, refreshDemProviders, setDemProviders } from "../map-store/dem-registry.js";
import {
  createDemSettingsStore,
  DEM_SETTING_KEYS,
  demSettingsStatus,
  effectiveDemConfig,
  maskSecret,
  NO_SAVED_DEM_SETTINGS,
  type SavedDemSettings,
} from "../map-store/dem-settings.js";
import { DemFetchError } from "../map-store/dem-cog.js";

/** Obviously fake test values. */
const ENV_CRED = "env-user:env-test-password";
const PASSWORD = "saved-test-password";

function memoryDeps() {
  const rows = new Map<string, string>();
  return {
    rows,
    deps: {
      getSetting: async (k: string) => rows.get(k) ?? null,
      setSetting: async (k: string, v: string | null) => void (v === null ? rows.delete(k) : rows.set(k, v)),
      insertSettingIfAbsent: async (k: string, v: string) => {
        if (!rows.has(k)) rows.set(k, v);
        return rows.get(k) as string;
      },
    },
  };
}

async function savedWithAccount(user = "saved-user"): Promise<{ saved: SavedDemSettings; rows: Map<string, string> }> {
  const { rows, deps } = memoryDeps();
  const store = createDemSettingsStore(deps);
  await store.setAccount({ user, password: PASSWORD, savedBy: "admin@oxygen.test" }, new Date("2026-11-15T10:00:00Z"));
  return { saved: await store.load(), rows };
}

describe("DEM settings over the environment (map-terrain.md §7.8 \"Precedence\")", () => {
  it("is off with nothing saved and nothing in the environment", () => {
    const c = effectiveDemConfig({}, NO_SAVED_DEM_SETTINGS);
    expect(c).toMatchObject({ lantmateriet: false, glo30: false, providersOrigin: "default", resolutionM: 2, resolutionOrigin: "default", account: null, warnings: [] });
  });

  it("reads the environment when nothing is saved", () => {
    const c = effectiveDemConfig({ MAP_DEM_PROVIDERS: "lantmateriet,glo30", MAP_DEM_LANTMATERIET_AUTH: `${ENV_CRED}\n`, MAP_DEM_LANTMATERIET_RESOLUTION_M: "1" }, NO_SAVED_DEM_SETTINGS);
    expect(c).toMatchObject({ lantmateriet: true, glo30: true, providersOrigin: "environment", resolutionM: 1, resolutionOrigin: "environment" });
    expect(c.account).toMatchObject({ user: "env-user", credential: ENV_CRED, origin: "environment" });
  });

  it("lets each saved value win on its own", async () => {
    const env = { MAP_DEM_PROVIDERS: "lantmateriet,glo30", MAP_DEM_LANTMATERIET_AUTH: ENV_CRED, MAP_DEM_LANTMATERIET_RESOLUTION_M: "1" };
    // providers saved, the rest from the environment
    expect(effectiveDemConfig(env, { ...NO_SAVED_DEM_SETTINGS, providers: "glo30" })).toMatchObject({ lantmateriet: false, glo30: true, providersOrigin: "saved", resolutionM: 1, resolutionOrigin: "environment" });
    // a saved empty list is explicitly none, over an environment naming providers
    expect(effectiveDemConfig(env, { ...NO_SAVED_DEM_SETTINGS, providers: "" })).toMatchObject({ lantmateriet: false, glo30: false, providersOrigin: "saved" });
    // the resolution saved
    expect(effectiveDemConfig(env, { ...NO_SAVED_DEM_SETTINGS, resolution: "2" })).toMatchObject({ resolutionM: 2, resolutionOrigin: "saved", providersOrigin: "environment" });
    // the account saved over the environment's
    const { saved } = await savedWithAccount();
    const c = effectiveDemConfig(env, saved);
    expect(c.account).toMatchObject({ user: "saved-user", credential: `saved-user:${PASSWORD}`, origin: "saved", savedAt: "2026-11-15T10:00:00.000Z", savedBy: "admin@oxygen.test" });
    expect(c).toMatchObject({ lantmateriet: true, providersOrigin: "environment" });
  });

  it("keeps Lantmäteriet off without a usable account, with a warning and no secret in it", () => {
    const off = effectiveDemConfig({}, { ...NO_SAVED_DEM_SETTINGS, providers: "lantmateriet" });
    expect(off).toMatchObject({ lantmateriet: false });
    expect(off.warnings.map((w) => w.code)).toEqual(["lantmateriet-no-account"]);
    const bad = effectiveDemConfig({ MAP_DEM_LANTMATERIET_AUTH: "no-colon-secret" }, { ...NO_SAVED_DEM_SETTINGS, providers: "lantmateriet" });
    expect(bad.warnings.map((w) => w.code)).toEqual(["lantmateriet-bad-account"]);
    expect(JSON.stringify(bad)).not.toContain("no-colon-secret");
    expect(effectiveDemConfig({}, { ...NO_SAVED_DEM_SETTINGS, providers: "srtm,glo30" }).warnings.map((w) => w.code)).toEqual(["unknown-provider"]);
    expect(effectiveDemConfig({ MAP_DEM_LANTMATERIET_RESOLUTION_M: "5" }, NO_SAVED_DEM_SETTINGS).warnings.map((w) => w.code)).toEqual(["bad-resolution"]);
  });

  it("never falls back to the environment's account when the saved one cannot be opened", async () => {
    const { saved } = await savedWithAccount();
    const env = { MAP_DEM_PROVIDERS: "lantmateriet", MAP_DEM_LANTMATERIET_AUTH: ENV_CRED };
    for (const broken of [{ ...saved, secretKey: null }, { ...saved, secretKey: Buffer.alloc(32, 7).toString("base64") }, { ...saved, account: "{not json" }]) {
      const c = effectiveDemConfig(env, broken);
      expect(c).toMatchObject({ lantmateriet: false, account: null, accountUnreadable: true });
      expect(c.warnings.map((w) => w.code)).toEqual(["account-unreadable"]);
    }
  });
});

describe("the DEM settings store (map-terrain.md §7.8 \"Sealing\")", () => {
  it("seals the password: the row holds neither it nor its base64, and one key serves every save", async () => {
    const { rows, deps } = memoryDeps();
    const store = createDemSettingsStore(deps);
    await store.setAccount({ user: "saved-user", password: PASSWORD, savedBy: null });
    const key = rows.get(DEM_SETTING_KEYS.secretKey);
    await store.setAccount({ user: "saved-user", password: `${PASSWORD}-2`, savedBy: null });
    expect(rows.get(DEM_SETTING_KEYS.secretKey)).toBe(key);
    for (const v of rows.values()) {
      expect(v).not.toContain(PASSWORD);
      expect(v).not.toContain(Buffer.from(PASSWORD).toString("base64"));
      expect(v).not.toContain(Buffer.from(`saved-user:${PASSWORD}-2`).toString("base64"));
    }
    expect(effectiveDemConfig({}, await store.load()).account?.credential).toBe(`saved-user:${PASSWORD}-2`);
  });

  it("refuses a malformed account and clears to the environment, keeping the key", async () => {
    const { rows, deps } = memoryDeps();
    const store = createDemSettingsStore(deps);
    await expect(store.setAccount({ user: "a:b", password: "x", savedBy: null })).rejects.toThrow();
    await expect(store.setAccount({ user: "a b", password: "x", savedBy: null })).rejects.toThrow();
    await expect(store.setAccount({ user: "ab", password: "", savedBy: null })).rejects.toThrow();
    expect(rows.size).toBe(0);
    await store.setAccount({ user: "saved-user", password: PASSWORD, savedBy: null });
    await store.clearAccount();
    expect(rows.has(DEM_SETTING_KEYS.account)).toBe(false);
    expect(rows.has(DEM_SETTING_KEYS.secretKey)).toBe(true);
    expect(effectiveDemConfig({ MAP_DEM_LANTMATERIET_AUTH: ENV_CRED }, await store.load()).account?.origin).toBe("environment");
  });

  it("saves and resets the providers and the resolution", async () => {
    const { rows, deps } = memoryDeps();
    const store = createDemSettingsStore(deps);
    await store.saveProviders({ lantmateriet: false, glo30: true });
    await store.saveResolution(1);
    expect(rows.get(DEM_SETTING_KEYS.providers)).toBe("glo30");
    expect(rows.get(DEM_SETTING_KEYS.resolution)).toBe("1");
    await store.saveProviders({ lantmateriet: false, glo30: false });
    expect(rows.get(DEM_SETTING_KEYS.providers)).toBe("");
    await store.saveProviders(null);
    await store.saveResolution(null);
    expect(rows.size).toBe(0);
  });
});

describe("nothing secret in a response (map-terrain.md §7.8 \"What leaves the server\")", () => {
  it("the status has the user name, origin and time, never the password", async () => {
    const { saved, rows } = await savedWithAccount();
    const envs = [{}, { MAP_DEM_PROVIDERS: "lantmateriet,glo30", MAP_DEM_LANTMATERIET_AUTH: ENV_CRED }];
    const saves: SavedDemSettings[] = [NO_SAVED_DEM_SETTINGS, saved, { ...saved, providers: "lantmateriet" }, { ...saved, secretKey: null }];
    for (const env of envs)
      for (const s of saves) {
        const text = JSON.stringify(demSettingsStatus(env, s));
        for (const secret of [PASSWORD, "env-test-password", rows.get(DEM_SETTING_KEYS.account) ?? "", JSON.parse(rows.get(DEM_SETTING_KEYS.account) ?? "{}").secret, rows.get(DEM_SETTING_KEYS.secretKey) ?? ""]) {
          expect(text).not.toContain(secret);
        }
      }
    const st = demSettingsStatus({}, { ...saved, providers: "lantmateriet" });
    expect(st.account).toEqual({ saved: true, user: "saved-user", origin: "saved", savedAt: "2026-11-15T10:00:00.000Z", savedBy: "admin@oxygen.test" });
    expect(st.active).toEqual({ lantmateriet: true, glo30: false });
    expect(demSettingsStatus({ MAP_DEM_LANTMATERIET_AUTH: ENV_CRED }, NO_SAVED_DEM_SETTINGS).account).toMatchObject({ user: "env-user", origin: "environment" });
  });

  it("masks a known secret, its base64 and any Basic value", () => {
    const text = `got ${PASSWORD} and ${Buffer.from(PASSWORD).toString("base64")} and Basic ${Buffer.from(ENV_CRED).toString("base64")}`;
    const masked = maskSecret(text, [PASSWORD, null]);
    expect(masked).not.toContain(PASSWORD);
    expect(masked).not.toContain(Buffer.from(PASSWORD).toString("base64"));
    expect(masked).toContain("Basic …");
  });
});

describe("the registry reads the settings at runtime (map-terrain.md §7.8)", () => {
  afterEach(() => {
    configureDemConfigSource(null);
    setDemProviders([]);
  });

  it("rebuilds the providers only when the effective configuration changes", async () => {
    let saved: SavedDemSettings = NO_SAVED_DEM_SETTINGS;
    let reads = 0;
    const fetch = demBaseFetch({}, async () => new Response(null, { status: 404 }));
    configureDemConfigSource({ load: async () => (reads++, saved), env: { MAP_DEM_PROVIDERS: "glo30" }, fetch, warn: () => undefined });
    const first = await refreshDemProviders();
    expect(first.map((p) => p.info.id)).toEqual(["glo30-30m"]);
    const again = await refreshDemProviders();
    expect(again[0]).toBe(first[0]);
    saved = { ...NO_SAVED_DEM_SETTINGS, providers: "" };
    expect(await refreshDemProviders()).toEqual([]);
    expect(demProviders()).toEqual([]);
    // within maxAgeMs the descriptor's path does not read again
    const before = reads;
    await refreshDemProviders({ maxAgeMs: 60_000 });
    expect(reads).toBe(before);
  });

  it("keeps the providers set directly when no source is installed, and the current list when a read fails", async () => {
    expect(await refreshDemProviders()).toEqual([]);
    configureDemConfigSource({ load: async () => ({ ...NO_SAVED_DEM_SETTINGS, providers: "glo30" }), env: {}, fetch: demBaseFetch({}), warn: () => undefined });
    await refreshDemProviders();
    configureDemConfigSource({ load: async () => Promise.reject(new Error("db down")), env: {}, fetch: demBaseFetch({}), warn: () => undefined });
    expect((await refreshDemProviders()).map((p) => p.info.id)).toEqual(["glo30-30m"]);
  });
});

describe("MAP_DEM_OFFLINE (map-terrain.md §7.8 \"Offline stacks\")", () => {
  it("refuses before the base fetch is called", async () => {
    let called = 0;
    const base = async () => (called++, new Response(null, { status: 206 }));
    const off = demBaseFetch({ MAP_DEM_OFFLINE: "1" }, base);
    await expect(off("https://api.lantmateriet.se/stac-hojd/v1/search", { headers: {} })).rejects.toBeInstanceOf(DemFetchError);
    await expect(off("https://api.lantmateriet.se/x", { headers: {} })).rejects.toMatchObject({ reason: "http" });
    expect(called).toBe(0);
    await demBaseFetch({}, base)("https://example.test/", { headers: {} });
    expect(called).toBe(1);
  });
});
