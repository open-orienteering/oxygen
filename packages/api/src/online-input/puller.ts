/**
 * Online-input puller.
 *
 * One interval timer per enabled event. Each tick:
 *   1. Loads the per-event config (`getSetting("online_input_<id>_config")`).
 *   2. Builds a protocol-specific GET request via `Protocol.buildRequest`.
 *   3. Fetches the response body with a hard timeout.
 *   4. Parses it through `Protocol.parseResponse` and de-dupes via `lastId`.
 *   5. Applies the per-event control mapping (`loadMapping`) to translate
 *      raw codes into the special-punch targets (1=start, 2=finish,
 *      3=check), leaving regular codes untouched.
 *   6. Inserts new rows into `punches` (`source = "online_input"`),
 *      resolving each control via `(event_id, control_code)` so the matcher
 *      can later attach the punch to a course.
 *   7. Bumps the persisted `lastId` watermark and the status counters
 *      (`last_polled`, `poll_count`, `punches_imported`).
 *
 * The puller is deliberately stateless across ticks — the watermark and
 * counters live in `oxygen.settings` so a server restart resumes from the
 * same place.
 */

import { prisma, getSetting, setSetting } from "../db.js";
import {
  type Protocol,
  type ProtocolConfig,
  type ProtocolId,
  type RemotePunch,
} from "./protocol.js";
import { uuidv7 } from "uuidv7";
import { rocProtocol } from "./roc.js";
import { loadMapping, applyMapping } from "./mapping.js";
import { appendJournal } from "../journalEmit.js";

const protocolById: Record<ProtocolId, Protocol> = {
  roc: rocProtocol,
};

const POLL_TIMEOUT_MS = 15_000;

type OnlineInputConfig = {
  enabled: boolean;
  protocol: ProtocolId;
  unitId: string;
  endpointUrl: string;
  intervalSeconds: number;
  mapping: Record<number, 1 | 2 | 3>;
  lastId: number;
};

function settingKey(eventId: bigint | number, name: string): string {
  return `online_input_${String(eventId)}_${name}`;
}

async function loadConfig(eventId: bigint): Promise<OnlineInputConfig | null> {
  const raw = await getSetting(settingKey(eventId, "config"));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OnlineInputConfig>;
    return {
      enabled: parsed.enabled === true,
      protocol: (parsed.protocol === "roc" ? "roc" : "roc") as ProtocolId, // only ROC is implemented; SICenter falls back here

      unitId: typeof parsed.unitId === "string" ? parsed.unitId : "",
      endpointUrl:
        typeof parsed.endpointUrl === "string" ? parsed.endpointUrl : "",
      intervalSeconds:
        typeof parsed.intervalSeconds === "number" && parsed.intervalSeconds > 0
          ? parsed.intervalSeconds
          : 10,
      mapping: { ...(parsed.mapping ?? {}) } as Record<number, 1 | 2 | 3>,
      lastId:
        typeof parsed.lastId === "number" && parsed.lastId >= 0
          ? parsed.lastId
          : 0,
    };
  } catch {
    return null;
  }
}

async function saveConfig(
  eventId: bigint,
  cfg: OnlineInputConfig,
): Promise<void> {
  await setSetting(settingKey(eventId, "config"), JSON.stringify(cfg));
}

async function bumpCounter(
  eventId: bigint,
  name: string,
  delta: number,
): Promise<number> {
  const raw = await getSetting(settingKey(eventId, name));
  const next = (raw ? parseInt(raw, 10) || 0 : 0) + delta;
  await setSetting(settingKey(eventId, name), String(next));
  return next;
}

async function recordError(eventId: bigint, msg: string): Promise<void> {
  await setSetting(settingKey(eventId, "last_error"), msg);
}

async function clearError(eventId: bigint): Promise<void> {
  await setSetting(settingKey(eventId, "last_error"), null);
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Resolve `(event_id, control_code)` to a `controls.id` (UUID), with a
 * one-shot cache for the duration of a single tick. The matcher uses
 * `control_id` to attach the punch to a course later.
 */
async function buildControlIndex(
  eventId: bigint,
): Promise<Map<number, string>> {
  const rows = await prisma().control.findMany({
    where: { eventId, removed: false },
    select: { id: true, codes: true },
  });
  const map = new Map<number, string>();
  for (const r of rows) {
    for (const part of (r.codes ?? "").split(";")) {
      const n = parseInt(part, 10);
      if (Number.isFinite(n)) map.set(n, r.id);
    }
  }
  return map;
}

async function pollOnce(eventId: bigint): Promise<void> {
  const cfg = await loadConfig(eventId);
  if (!cfg || !cfg.enabled || !cfg.endpointUrl || !cfg.unitId) return;

  const proto = protocolById[cfg.protocol];
  if (!proto) {
    await recordError(eventId, `Unknown protocol: ${cfg.protocol}`);
    return;
  }

  const event = await prisma().event.findUnique({
    where: { id: eventId },
    select: { date: true, zeroTime: true, nameId: true },
  });
  if (!event) return;

  const dateStr = event.date.toISOString().slice(0, 10);
  const req = proto.buildRequest(
    {
      protocol: cfg.protocol,
      endpointUrl: cfg.endpointUrl,
      unitId: cfg.unitId,
    } satisfies ProtocolConfig,
    cfg.lastId,
    { date: dateStr, zeroTimeDs: event.zeroTime },
  );

  let body: string;
  try {
    body = await fetchWithTimeout(req.url, POLL_TIMEOUT_MS);
  } catch (err) {
    await recordError(
      eventId,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  let parsed: RemotePunch[];
  try {
    parsed = proto.parseResponse(body);
  } catch (err) {
    await recordError(
      eventId,
      `Parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // De-dupe via lastId and apply the user's control mapping. Mapped
  // codes become 1/2/3 (start/finish/check) on the punch row; the
  // original raw code is preserved in the `control_code` column for
  // operator diagnostics — but the mapping winning rule keeps the
  // matcher's life simple by storing the *effective* code.
  const newPunches = parsed.filter((p) => p.punchId > cfg.lastId);
  if (newPunches.length === 0) {
    await setSetting(settingKey(eventId, "last_polled"), new Date().toISOString());
    await bumpCounter(eventId, "poll_count", 1);
    await clearError(eventId);
    return;
  }

  const mapping = await loadMapping(event.nameId);
  const controlIdByCode = await buildControlIndex(eventId);
  let maxId = cfg.lastId;

  // Inserts run in a single transaction so a partial failure rolls
  // back cleanly. We *do not* defensively re-check punch existence —
  // ROC's lastId protocol guarantees monotonicity. Each punch is a
  // race-critical fact, so it is journaled in the same transaction
  // (payload carries the ABSOLUTE decisecond time so it is node-portable).
  const stationId = `roc-${cfg.unitId}`;
  await prisma().$transaction(async (tx) => {
    for (const p of newPunches) {
      const effectiveCode = applyMapping(mapping, p.rawCode);
      const time = p.absoluteTimeDs - event.zeroTime;
      const controlId = controlIdByCode.get(effectiveCode) ?? null;
      // Minted here and carried in the payload so every node stores the
      // punch under the same UUID (punch edits address rows by id).
      const punchId = uuidv7();
      await tx.punch.create({
        data: {
          id: punchId,
          eventId,
          cardNo: p.cardNo,
          controlCode: effectiveCode,
          controlId,
          time,
          source: "online_input",
          isOriginal: true,
        },
      });
      await appendJournal(tx, {
        eventId,
        type: "punch.recorded",
        stationId,
        payload: {
          id: punchId,
          cardNo: p.cardNo,
          controlCode: effectiveCode,
          time: p.absoluteTimeDs,
          origin: "online_input",
        },
      });
      if (p.punchId > maxId) maxId = p.punchId;
    }
  });

  cfg.lastId = maxId;
  await saveConfig(eventId, cfg);

  await bumpCounter(eventId, "poll_count", 1);
  await bumpCounter(eventId, "punches_imported", newPunches.length);
  await setSetting(
    settingKey(eventId, "last_polled"),
    new Date().toISOString(),
  );
  await clearError(eventId);
}

/**
 * Per-event poller. The lifecycle is owned by the puller registry —
 * `setEnabled(true)` starts an interval, `setEnabled(false)` stops it.
 */
interface PullerHandle {
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

function eventPuller(eventId: bigint, intervalSeconds: number): PullerHandle {
  let timer: NodeJS.Timeout | null = null;
  let busy = false;
  const tick = () => {
    if (busy) return; // Skip overlapping ticks.
    busy = true;
    pollOnce(eventId)
      .catch(async (err) => {
        await recordError(
          eventId,
          err instanceof Error ? err.message : String(err),
        ).catch(() => {});
      })
      .finally(() => {
        busy = false;
      });
  };
  return {
    start() {
      if (timer) return;
      // Fire one immediate poll so the operator sees the indicator move
      // without waiting up to N seconds.
      tick();
      timer = setInterval(tick, intervalSeconds * 1000);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    isRunning() {
      return timer !== null;
    },
  };
}

// Per-event registry — keyed by stringified event id (BigInt is not a
// valid Map key for stable lookups across reloads).
const registry = new Map<string, PullerHandle>();

export function onlineInputPuller(): { start(): void; stop(): void } {
  return {
    start() {
      // The puller is event-scoped; the global handle just exists for
      // symmetry with `liveResultsPusher()`. Real work happens in
      // `reconcileEnabledPullers` and via `setPullerEnabled` from the
      // tRPC router.
    },
    stop() {
      for (const handle of registry.values()) handle.stop();
      registry.clear();
    },
  };
}

/**
 * Enable / disable the per-event puller from outside (tRPC enable /
 * disable mutations call this). Reads the persisted config to figure
 * out the interval.
 */
export async function setPullerEnabled(
  eventId: bigint,
  enabled: boolean,
): Promise<void> {
  const cfg = await loadConfig(eventId);
  if (!cfg) return;
  const key = String(eventId);
  const existing = registry.get(key);
  if (enabled) {
    if (existing) existing.stop();
    const handle = eventPuller(eventId, cfg.intervalSeconds);
    registry.set(key, handle);
    handle.start();
  } else if (existing) {
    existing.stop();
    registry.delete(key);
  }
}

/**
 * On API startup, scan every event with an enabled online-input config
 * and bring up the corresponding puller. Settings live in a single
 * table so this is one Prisma query.
 */
export async function reconcileEnabledPullers(): Promise<void> {
  const rows = await prisma().setting.findMany({
    where: { key: { startsWith: "online_input_" } },
    select: { key: true, value: true },
  });
  for (const row of rows) {
    const m = /^online_input_(\d+)_config$/.exec(row.key);
    if (!m) continue;
    const eventId = BigInt(m[1]);
    if (row.value == null) continue;
    let cfg: Partial<OnlineInputConfig> | null = null;
    try {
      cfg = JSON.parse(row.value) as Partial<OnlineInputConfig>;
    } catch {
      continue;
    }
    if (cfg?.enabled === true) {
      await setPullerEnabled(eventId, true).catch(() => {});
    }
  }
}

/** Run one poll on demand. Returns `{ fetched, inserted }` for the UI. */
export async function pollOnceForEvent(
  eventId: bigint,
): Promise<{ fetched: number; inserted: number }> {
  const before = await getSetting(settingKey(eventId, "punches_imported"));
  const beforeCount = before ? parseInt(before, 10) || 0 : 0;
  const beforeCfg = await loadConfig(eventId);
  const beforeLastId = beforeCfg?.lastId ?? 0;
  await pollOnce(eventId);
  const afterCfg = await loadConfig(eventId);
  const afterLastId = afterCfg?.lastId ?? beforeLastId;
  const after = await getSetting(settingKey(eventId, "punches_imported"));
  const afterCount = after ? parseInt(after, 10) || 0 : 0;
  // `fetched` here is the count we advanced lastId by (i.e. how many
  // ids we consumed); `inserted` is what actually hit `punches`. They
  // can diverge when malformed rows are dropped at parse time.
  return {
    fetched: Math.max(0, afterLastId - beforeLastId),
    inserted: Math.max(0, afterCount - beforeCount),
  };
}
