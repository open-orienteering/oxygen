/**
 * The DEM settings (docs/map-terrain.md §7.0b, §7.8): Settings → Height
 * data's rows in `oxygen_settings`, each over its `MAP_DEM_*` variable.
 *
 * - The provider pair, the resolution and the account are each the saved
 *   row when there is one, else the environment (§7.0b 6). Nothing saved
 *   and nothing in the environment is no provider.
 * - The account's password is sealed (`secret-box.ts`) with a key kept in
 *   a row beside it (§7.0b answer 10); it never leaves this module except
 *   as the `user:password` credential handed to the provider, which sends
 *   it only to Lantmäteriet's hosts (§7.1).
 * - `demSettingsStatus` is the only shape a response is built from: it has
 *   no field that could carry the password.
 *
 * The store is dependency-injected like `eventorKeyStore.ts`.
 */

import { newSecretKey, open, seal } from "../secret-box.js";

export const DEM_SETTING_KEYS = {
  providers: "map_dem.providers",
  resolution: "map_dem.lantmateriet_resolution_m",
  account: "map_dem.lantmateriet_account",
  secretKey: "map_dem.secret_key",
  liveCheck: "map_dem.live_check",
} as const;

export type DemSettingOrigin = "saved" | "environment" | "default";
export type DemResolutionM = 1 | 2;

export type DemWarningCode =
  | "unknown-provider"
  | "bad-resolution"
  | "lantmateriet-no-account"
  | "lantmateriet-bad-account"
  | "account-unreadable";

export interface DemWarning {
  code: DemWarningCode;
  /** English, for the log; never carries a secret. */
  message: string;
}

/** The rows as stored (null = absent). */
export interface SavedDemSettings {
  providers: string | null;
  resolution: string | null;
  account: string | null;
  secretKey: string | null;
}

export const NO_SAVED_DEM_SETTINGS: SavedDemSettings = { providers: null, resolution: null, account: null, secretKey: null };

/** The stored account row: the password sealed, the rest in the clear. */
interface StoredAccount {
  user: string;
  secret: string;
  savedAt: string;
  savedBy: string | null;
}

export interface DemAccount {
  user: string;
  /** `user:password`, for the provider only. */
  credential: string;
  origin: "saved" | "environment";
  savedAt: string | null;
  savedBy: string | null;
}

export interface DemConfig {
  lantmateriet: boolean;
  glo30: boolean;
  providersOrigin: DemSettingOrigin;
  resolutionM: DemResolutionM;
  resolutionOrigin: DemSettingOrigin;
  /** The usable account, whether or not Lantmäteriet is on. */
  account: DemAccount | null;
  /** A saved account row exists but cannot be opened. */
  accountUnreadable: boolean;
  warnings: DemWarning[];
}

const CREDENTIAL_FORM = /^[^:\s]+:\S.*$/s;
/** A user name the credential's `user:password` form can carry. */
export const DEM_ACCOUNT_USER = /^[^:\s]+$/;

function parseProviders(list: string, warnings: DemWarning[], from: string): { lantmateriet: boolean; glo30: boolean } {
  const names = list.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const n of names) if (n !== "lantmateriet" && n !== "glo30") warnings.push({ code: "unknown-provider", message: `ignoring unknown DEM provider ${JSON.stringify(n)} in ${from}` });
  return { lantmateriet: names.includes("lantmateriet"), glo30: names.includes("glo30") };
}

function parseStoredAccount(raw: string): StoredAccount | null {
  try {
    const v = JSON.parse(raw) as Partial<StoredAccount>;
    if (typeof v.user !== "string" || typeof v.secret !== "string" || typeof v.savedAt !== "string") return null;
    return { user: v.user, secret: v.secret, savedAt: v.savedAt, savedBy: typeof v.savedBy === "string" ? v.savedBy : null };
  } catch {
    return null;
  }
}

/** The effective configuration: each saved value over its variable (§7.8 "Precedence"). Pure. */
export function effectiveDemConfig(env: NodeJS.ProcessEnv, saved: SavedDemSettings): DemConfig {
  const warnings: DemWarning[] = [];

  const fromEnvProviders = (env.MAP_DEM_PROVIDERS ?? "").trim();
  const providersOrigin: DemSettingOrigin = saved.providers !== null ? "saved" : fromEnvProviders !== "" ? "environment" : "default";
  const providers = parseProviders(saved.providers ?? fromEnvProviders, warnings, saved.providers !== null ? "the saved settings" : "MAP_DEM_PROVIDERS");

  let resolutionM: DemResolutionM = 2;
  let resolutionOrigin: DemSettingOrigin = "default";
  if (saved.resolution === "1" || saved.resolution === "2") {
    resolutionM = saved.resolution === "1" ? 1 : 2;
    resolutionOrigin = "saved";
  } else {
    const res = env.MAP_DEM_LANTMATERIET_RESOLUTION_M;
    if (res === "1" || res === "2") {
      resolutionM = res === "1" ? 1 : 2;
      resolutionOrigin = "environment";
    } else if (res !== undefined && res !== "") {
      warnings.push({ code: "bad-resolution", message: "MAP_DEM_LANTMATERIET_RESOLUTION_M must be 1 or 2; reading 2" });
    }
  }

  let account: DemAccount | null = null;
  let accountUnreadable = false;
  if (saved.account !== null) {
    const stored = parseStoredAccount(saved.account);
    let password: string | null = null;
    if (stored && saved.secretKey) {
      try {
        password = open(stored.secret, Buffer.from(saved.secretKey, "base64"), DEM_SETTING_KEYS.account);
      } catch {
        password = null;
      }
    }
    if (stored && password !== null && DEM_ACCOUNT_USER.test(stored.user) && password.length > 0) {
      account = { user: stored.user, credential: `${stored.user}:${password}`, origin: "saved", savedAt: stored.savedAt, savedBy: stored.savedBy };
    } else {
      accountUnreadable = true;
      warnings.push({ code: "account-unreadable", message: "the saved Lantmäteriet account cannot be opened; enter it again in Settings → Height data" });
    }
  } else {
    // trimmed: a secret typed at `gcloud secrets create --data-file=-` ends in a newline
    const cred = (env.MAP_DEM_LANTMATERIET_AUTH ?? "").trim();
    if (CREDENTIAL_FORM.test(cred)) account = { user: cred.slice(0, cred.indexOf(":")), credential: cred, origin: "environment", savedAt: null, savedBy: null };
    else if (cred !== "") warnings.push({ code: "lantmateriet-bad-account", message: "MAP_DEM_LANTMATERIET_AUTH is not of the form user:password; Lantmäteriet is off" });
  }

  let lantmateriet = providers.lantmateriet;
  if (lantmateriet && !account) {
    lantmateriet = false;
    if (!accountUnreadable && !warnings.some((w) => w.code === "lantmateriet-bad-account"))
      warnings.push({ code: "lantmateriet-no-account", message: "Lantmäteriet is on but no account is saved and MAP_DEM_LANTMATERIET_AUTH is not set; it is off" });
  }
  return { lantmateriet, glo30: providers.glo30, providersOrigin, resolutionM, resolutionOrigin, account, accountUnreadable, warnings };
}

/** Lantmäteriet as asked for, before the account check (the switch the tab shows). */
export function requestedProviders(env: NodeJS.ProcessEnv, saved: SavedDemSettings): { lantmateriet: boolean; glo30: boolean } {
  return parseProviders(saved.providers ?? (env.MAP_DEM_PROVIDERS ?? ""), [], "");
}

/** What the providers are built from; equal fingerprints build equal providers. Holds the credential: never logged or returned. */
export function demConfigFingerprint(c: DemConfig): string {
  return JSON.stringify([c.lantmateriet, c.glo30, c.resolutionM, c.lantmateriet ? c.account?.credential ?? null : null]);
}

// ---- the public shape ----------------------------------------------------------

export interface DemAccountStatus {
  saved: true;
  user: string;
  origin: "saved" | "environment";
  savedAt: string | null;
  savedBy: string | null;
}

export interface DemSettingsStatus {
  providers: { lantmateriet: boolean; glo30: boolean; origin: DemSettingOrigin };
  /** Lantmäteriet asked for and actually on (it needs an account). */
  active: { lantmateriet: boolean; glo30: boolean };
  resolutionM: DemResolutionM;
  resolutionOrigin: DemSettingOrigin;
  account: DemAccountStatus | null;
  accountUnreadable: boolean;
  /** The environment has a value under the saved one (the tab's "reset to the deploy's default"). */
  environment: { providers: boolean; resolution: boolean; account: boolean };
  warnings: DemWarningCode[];
}

/** The status every response is built from: no field carries the password (§7.8 "What leaves the server"). */
export function demSettingsStatus(env: NodeJS.ProcessEnv, saved: SavedDemSettings): DemSettingsStatus {
  const c = effectiveDemConfig(env, saved);
  const requested = requestedProviders(env, saved);
  return {
    providers: { ...requested, origin: c.providersOrigin },
    active: { lantmateriet: c.lantmateriet, glo30: c.glo30 },
    resolutionM: c.resolutionM,
    resolutionOrigin: c.resolutionOrigin,
    account: c.account ? { saved: true, user: c.account.user, origin: c.account.origin, savedAt: c.account.savedAt, savedBy: c.account.savedBy } : null,
    accountUnreadable: c.accountUnreadable,
    environment: {
      providers: (env.MAP_DEM_PROVIDERS ?? "").trim() !== "",
      resolution: (env.MAP_DEM_LANTMATERIET_RESOLUTION_M ?? "") !== "",
      account: (env.MAP_DEM_LANTMATERIET_AUTH ?? "").trim() !== "",
    },
    warnings: [...new Set(c.warnings.map((w) => w.code))],
  };
}

/** Secrets shorter than this are not masked by substring: a short one would mangle ordinary words. */
export const MASK_MIN_CHARS = 6;

/**
 * Removes each secret (and its base64) and any `Basic …` value from a
 * free text bound for a row or a response. Not for structured data: the
 * live check's report is checked whole instead (§7.8).
 */
export function maskSecret(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < MASK_MIN_CHARS) continue;
    out = out.split(s).join("…");
    out = out.split(Buffer.from(s, "utf8").toString("base64")).join("…");
  }
  return out.replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic …");
}

// ---- the store -----------------------------------------------------------------

export interface DemSettingsDeps {
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string | null) => Promise<void>;
  /** Inserts the row unless one exists; returns the row's value either way (one key per database, races included). */
  insertSettingIfAbsent: (key: string, value: string) => Promise<string>;
}

export function createDemSettingsStore(deps: DemSettingsDeps) {
  async function load(): Promise<SavedDemSettings> {
    const [providers, resolution, account, secretKey] = await Promise.all([
      deps.getSetting(DEM_SETTING_KEYS.providers),
      deps.getSetting(DEM_SETTING_KEYS.resolution),
      deps.getSetting(DEM_SETTING_KEYS.account),
      deps.getSetting(DEM_SETTING_KEYS.secretKey),
    ]);
    return { providers, resolution, account, secretKey };
  }

  /** null resets to the environment (deletes the row). */
  async function saveProviders(p: { lantmateriet: boolean; glo30: boolean } | null): Promise<void> {
    const value = p === null ? null : [p.lantmateriet ? "lantmateriet" : null, p.glo30 ? "glo30" : null].filter(Boolean).join(",");
    await deps.setSetting(DEM_SETTING_KEYS.providers, value);
  }

  async function saveResolution(m: DemResolutionM | null): Promise<void> {
    await deps.setSetting(DEM_SETTING_KEYS.resolution, m === null ? null : String(m));
  }

  /** Seals and saves the account; the form is checked by the caller's schema and again here. */
  async function setAccount(input: { user: string; password: string; savedBy: string | null }, now: Date = new Date()): Promise<void> {
    if (!DEM_ACCOUNT_USER.test(input.user)) throw new Error("the user name must not be empty or contain ':' or spaces");
    if (input.password.length === 0) throw new Error("the password must not be empty");
    const keyB64 = await deps.insertSettingIfAbsent(DEM_SETTING_KEYS.secretKey, newSecretKey().toString("base64"));
    const stored: StoredAccount = { user: input.user, secret: seal(input.password, Buffer.from(keyB64, "base64"), DEM_SETTING_KEYS.account), savedAt: now.toISOString(), savedBy: input.savedBy };
    await deps.setSetting(DEM_SETTING_KEYS.account, JSON.stringify(stored));
  }

  /** Removes the saved account; the key stays (§7.8). */
  async function clearAccount(): Promise<void> {
    await deps.setSetting(DEM_SETTING_KEYS.account, null);
  }

  async function getLiveCheck(): Promise<unknown> {
    const raw = await deps.getSetting(DEM_SETTING_KEYS.liveCheck);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  async function setLiveCheck(value: unknown): Promise<void> {
    await deps.setSetting(DEM_SETTING_KEYS.liveCheck, value === null ? null : JSON.stringify(value));
  }

  return { load, saveProviders, saveResolution, setAccount, clearAccount, getLiveCheck, setLiveCheck };
}

export type DemSettingsStore = ReturnType<typeof createDemSettingsStore>;
