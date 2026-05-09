/**
 * Online-input puller manager.
 *
 * Mirrors `liveresults.ts`'s `LiveResultsPusherManager` design (boot-time
 * reconcile, per-`nameId` setInterval, in-process status counters), but
 * works in the opposite direction — pulling punches from a remote service
 * into the local `oPunch` table instead of pushing results outward.
 *
 * One pusher per competition per process. Each tick:
 *   1. Build a poll request via the configured `Protocol`.
 *   2. Fetch the response (15s timeout).
 *   3. Parse into `RemotePunch[]`.
 *   4. Apply the user's control mapping.
 *   5. Insert any rows with `punchId > lastId` into `oPunch`, with a
 *      MeOS-compatible `Origin` checksum.
 *   6. Advance `lastId` after each successful insert.
 *
 * AGENTS.md §7 (MeOS compatibility): every insert calls `incrementCounter`,
 * uses `Time` relative to ZeroTime, and stores `Origin` as `computeOrigin`
 * so MeOS sees the punch as `isOriginal()`.
 */

import { TRPCError } from "@trpc/server";
import {
  getCompetitionClient,
  getMainDbConnection,
  getSetting,
  setSetting,
  incrementCounter,
} from "../db.js";
import { computeOrigin } from "../meosOrigin.js";
import { toRelative } from "../timeConvert.js";
import {
  type Protocol,
  type ProtocolConfig,
  type ProtocolId,
  type PollEvent,
} from "./protocol.js";
import { rocProtocol, ROC_DEFAULT_ENDPOINT } from "./roc.js";
import { applyMapping, loadMapping, type ControlMapping } from "./mapping.js";

// ─── Protocol registry ──────────────────────────────────────

const protocolById: Record<ProtocolId, Protocol> = {
  roc: rocProtocol,
};

export function getProtocol(id: ProtocolId): Protocol {
  return protocolById[id];
}

// ─── Persistent config (oxygen_settings) ─────────────────────

const CONFIG_PREFIX = "online_input_config_";
const LAST_ID_PREFIX = "online_input_last_id_";

export interface OnlineInputConfig {
  enabled: boolean;
  protocol: ProtocolId;
  endpointUrl: string;
  unitId: string;
  intervalSeconds: number;
}

export const DEFAULT_CONFIG: OnlineInputConfig = {
  enabled: false,
  protocol: "roc",
  endpointUrl: ROC_DEFAULT_ENDPOINT,
  unitId: "",
  intervalSeconds: 10,
};

export function configKey(nameId: string): string {
  return `${CONFIG_PREFIX}${nameId}`;
}

export function lastIdKey(nameId: string): string {
  return `${LAST_ID_PREFIX}${nameId}`;
}

export async function loadConfig(nameId: string): Promise<OnlineInputConfig> {
  const raw = await getSetting(configKey(nameId));
  if (!raw) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(raw) as Partial<OnlineInputConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function persistConfig(
  nameId: string,
  config: OnlineInputConfig,
): Promise<void> {
  await setSetting(configKey(nameId), JSON.stringify(config));
}

export async function getLastId(nameId: string): Promise<number> {
  const raw = await getSetting(lastIdKey(nameId));
  if (!raw) return 0;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

export async function setLastId(nameId: string, value: number): Promise<void> {
  await setSetting(lastIdKey(nameId), String(value));
}

// ─── Single poll cycle ───────────────────────────────────────

export interface PollStats {
  fetched: number;
  inserted: number;
  skipped: number;
  newLastId: number;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Run one poll cycle for the given competition. Loads config, fetches the
 * remote endpoint, parses the response, applies the mapping, inserts new
 * punches into `oPunch`, and advances `lastId`.
 *
 * Throws on missing/invalid config so the caller (UI's "Poll now" button)
 * gets an actionable error. The interval timer captures errors into the
 * pusher's `lastError` state instead of letting them bubble up.
 */
export async function pollOnce(
  nameId: string,
  fetchFn: FetchFn = (url, init) => fetch(url, init),
): Promise<PollStats> {
  const cfg = await loadConfig(nameId);
  if (!cfg.enabled) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Online input is disabled for this competition",
    });
  }
  if (!cfg.unitId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "No unit ID configured",
    });
  }

  const protocol = getProtocol(cfg.protocol);
  if (!protocol) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Unknown online-input protocol: ${cfg.protocol}`,
    });
  }

  const client = await getCompetitionClient(nameId);
  const event = await client.oEvent.findFirst({
    where: { Removed: false },
    select: { Date: true, ZeroTime: true },
  });
  if (!event) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "No active oEvent row found",
    });
  }

  // event.Date is a VARCHAR; the production format is "YYYY-MM-DD". Tolerate
  // a leading "YYYY-MM-DDT..." (ISO-like) by slicing the first 10 chars.
  const date = (event.Date ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10);
  const zeroTimeDs = event.ZeroTime ?? 324000;
  const pollEvent: PollEvent = { date, zeroTimeDs };

  const lastId = await getLastId(nameId);
  const { url, headers } = protocol.buildRequest(cfg, lastId, pollEvent);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DEFAULT_TIMEOUT_MS);
  let body: string;
  try {
    const resp = await fetchFn(url, { headers, signal: ac.signal });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    body = await resp.text();
  } finally {
    clearTimeout(timer);
  }

  const punches = protocol.parseResponse(body);
  const mapping: ControlMapping = await loadMapping(nameId);

  const stats: PollStats = {
    fetched: punches.length,
    inserted: 0,
    skipped: 0,
    newLastId: lastId,
  };

  // Insert in id ascending order so a partial failure leaves a coherent
  // lastId. ROC delivers ascending already, but enforce it defensively.
  const ordered = [...punches].sort((a, b) => a.punchId - b.punchId);

  for (const p of ordered) {
    if (p.punchId <= stats.newLastId) {
      stats.skipped++;
      continue;
    }

    const type = applyMapping(mapping, p.rawCode);
    const relativeTimeDs = toRelative(p.absoluteTimeDs, zeroTimeDs);
    const origin = computeOrigin(p.absoluteTimeDs, type);

    const punch = await client.oPunch.create({
      data: {
        CardNo: p.cardNo,
        Type: type,
        Time: relativeTimeDs,
        Origin: origin,
      },
    });
    await incrementCounter("oPunch", punch.Id, nameId);

    stats.inserted++;
    stats.newLastId = p.punchId;
    await setLastId(nameId, p.punchId);
  }

  return stats;
}

// ─── Pusher manager (per-nameId interval timer) ──────────────

export interface PullerStatus {
  running: boolean;
  intervalSeconds: number | null;
  lastPoll: string | null;
  lastError: string | null;
  pollCount: number;
  punchesImported: number;
}

export type PollFn = (nameId: string) => Promise<PollStats>;

interface TenantState {
  timer: ReturnType<typeof setInterval>;
  intervalSeconds: number;
  lastPoll: string | null;
  lastError: string | null;
  pollCount: number;
  punchesImported: number;
}

class OnlineInputPullerManager {
  private tenants = new Map<string, TenantState>();

  getStatus(nameId: string): PullerStatus {
    const t = this.tenants.get(nameId);
    if (!t) {
      return {
        running: false,
        intervalSeconds: null,
        lastPoll: null,
        lastError: null,
        pollCount: 0,
        punchesImported: 0,
      };
    }
    return {
      running: true,
      intervalSeconds: t.intervalSeconds,
      lastPoll: t.lastPoll,
      lastError: t.lastError,
      pollCount: t.pollCount,
      punchesImported: t.punchesImported,
    };
  }

  isRunning(nameId: string): boolean {
    return this.tenants.has(nameId);
  }

  activeNameIds(): string[] {
    return [...this.tenants.keys()];
  }

  /**
   * Start (or restart) the puller timer for one competition. `pollFn` is
   * overridable for tests so we never hit the real network in unit tests.
   */
  start(
    nameId: string,
    intervalSeconds: number,
    pollFn: PollFn = pollOnce,
  ): void {
    this.stop(nameId);

    const state: TenantState = {
      timer: undefined as unknown as ReturnType<typeof setInterval>,
      intervalSeconds,
      lastPoll: null,
      lastError: null,
      pollCount: 0,
      punchesImported: 0,
    };

    const run = async () => {
      try {
        const stats = await pollFn(nameId);
        state.lastPoll = new Date().toISOString();
        state.pollCount++;
        state.punchesImported += stats.inserted;
        state.lastError = null;
      } catch (err) {
        state.lastError = err instanceof Error ? err.message : String(err);
        console.error(`[OnlineInput] Poll error for ${nameId}:`, err);
      }
    };

    state.timer = setInterval(run, intervalSeconds * 1000);
    this.tenants.set(nameId, state);
    void run();
  }

  stop(nameId: string): void {
    const t = this.tenants.get(nameId);
    if (!t) return;
    clearInterval(t.timer);
    this.tenants.delete(nameId);
  }

  stopAll(): void {
    for (const nameId of [...this.tenants.keys()]) {
      this.stop(nameId);
    }
  }
}

export const onlineInputPuller = new OnlineInputPullerManager();

// ─── Boot reconciler ─────────────────────────────────────────

export interface ReconcileResult {
  started: string[];
  skipped: string[];
  failed: Array<{ nameId: string; error: string }>;
}

/**
 * Re-arm puller timers for every competition whose persisted config has
 * `enabled: true` AND whose oEvent row still exists. Same orphan-handling
 * approach as `reconcileEnabledPushers` in `liveresults.ts` — settings
 * for a deleted/purged competition are reported as failures rather than
 * starting a phantom puller that would fail on every tick.
 */
export async function reconcileEnabledPullers(): Promise<ReconcileResult> {
  const result: ReconcileResult = { started: [], skipped: [], failed: [] };

  const conn = await getMainDbConnection();
  let rows: Array<{ SettingKey: string; SettingValue: string | null }>;
  const activeNameIds = new Set<string>();

  try {
    try {
      const [r] = await conn.execute(
        "SELECT SettingKey, SettingValue FROM oxygen_settings WHERE SettingKey LIKE ?",
        [`${CONFIG_PREFIX}%`],
      );
      rows = r as Array<{ SettingKey: string; SettingValue: string | null }>;
    } catch {
      // Settings table not yet provisioned — nothing to reconcile.
      return result;
    }

    try {
      const [activeRows] = await conn.execute(
        "SELECT NameId FROM oEvent WHERE Removed = 0",
      );
      for (const r of activeRows as Array<{ NameId: string }>) {
        if (r.NameId) activeNameIds.add(r.NameId);
      }
    } catch {
      // oEvent missing → treat every config as orphan so we don't start
      // phantom pullers.
    }
  } finally {
    await conn.end();
  }

  for (const row of rows) {
    const nameId = row.SettingKey.slice(CONFIG_PREFIX.length);
    try {
      if (!row.SettingValue) {
        result.skipped.push(nameId);
        continue;
      }
      const cfg = JSON.parse(row.SettingValue) as Partial<OnlineInputConfig>;
      if (!cfg.enabled) {
        result.skipped.push(nameId);
        continue;
      }
      if (!activeNameIds.has(nameId)) {
        result.failed.push({
          nameId,
          error: "competition not present in oEvent (orphan setting)",
        });
        continue;
      }
      if (!cfg.unitId) {
        result.failed.push({ nameId, error: "no unitId configured" });
        continue;
      }
      const intervalSeconds = cfg.intervalSeconds ?? DEFAULT_CONFIG.intervalSeconds;
      onlineInputPuller.start(nameId, intervalSeconds);
      result.started.push(nameId);
    } catch (err) {
      result.failed.push({
        nameId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
