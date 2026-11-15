/**
 * The instance's enabled DEM providers (docs/map-terrain.md §7.0 answer 4,
 * §7.8 "Reading the configuration at runtime"). With a config source
 * installed (the server, `index.ts`) the list is rebuilt from Settings →
 * Height data over the environment whenever the effective configuration
 * changes: `refreshDemProviders` runs before each engine kick, on the
 * tick and after every save. Without one (tests) the list is what
 * `setDemProviders` put there. Empty = no DEM is fetched.
 */

import type { RangeFetch } from "./dem-cog.js";
import { demProvidersFromConfig, type DemProvider } from "./dem-providers.js";
import { demConfigFingerprint, effectiveDemConfig, type SavedDemSettings } from "./dem-settings.js";

let providers: readonly DemProvider[] = [];

export interface DemConfigSource {
  /** The saved rows. */
  load: () => Promise<SavedDemSettings>;
  env: NodeJS.ProcessEnv;
  fetch: RangeFetch;
  warn?: (msg: string) => void;
}

let source: DemConfigSource | null = null;
let fingerprint: string | null = null;
let warned = new Set<string>();
let refreshedAt = 0;
/** Reads started / the newest read applied: an older read finishing last is dropped (§7.8). */
let started = 0;
let applied = 0;

export function setDemProviders(list: readonly DemProvider[]): void {
  providers = [...list];
}

/** Installs (or with null removes) the config source; the next refresh builds from it. */
export function configureDemConfigSource(s: DemConfigSource | null): void {
  source = s;
  fingerprint = null;
  warned = new Set();
  refreshedAt = 0;
}

/**
 * Re-reads the configuration and rebuilds the providers when it changed;
 * with `maxAgeMs`, only when the last read is older (the descriptor's
 * path). No-op without a source. A failed read keeps the current list.
 * Never throws.
 */
export async function refreshDemProviders(opts: { maxAgeMs?: number } = {}): Promise<readonly DemProvider[]> {
  const s = source;
  if (!s) return providers;
  if (opts.maxAgeMs !== undefined && Date.now() - refreshedAt < opts.maxAgeMs) return providers;
  refreshedAt = Date.now();
  const mine = ++started;
  let saved: SavedDemSettings;
  try {
    saved = await s.load();
  } catch (err: unknown) {
    console.error("[map-dem] reading the DEM settings failed:", err instanceof Error ? err.message : err);
    return providers;
  }
  if (s !== source || mine < applied) return providers;
  applied = mine;
  const config = effectiveDemConfig(s.env, saved);
  const fp = demConfigFingerprint(config);
  if (fp !== fingerprint) {
    fingerprint = fp;
    providers = demProvidersFromConfig(config, s.fetch);
    const warn = s.warn ?? ((m: string) => console.warn(`[map-dem] ${m}`));
    for (const w of config.warnings) if (!warned.has(w.message)) (warned.add(w.message), warn(w.message));
    console.log(`[map-dem] providers: ${providers.map((p) => p.info.id).join(", ") || "none"}`);
  }
  return providers;
}

/** In order: Lantmäteriet first, GLO-30 after (§7.0 answer 4). */
export function demProviders(): readonly DemProvider[] {
  return providers;
}

export function demProviderById(id: string): DemProvider | null {
  return providers.find((p) => p.info.id === id) ?? null;
}
