/**
 * LiveResults pusher — stub. The original module spun up one interval
 * timer per active competition that pushed start lists + result updates
 * to liveresultat.orientering.se. The full pipeline is being re-ported
 * against the new schema.
 */

export interface LiveResultsConfig {
  enabled: boolean;
}

const DEFAULT_CONFIG: LiveResultsConfig = { enabled: false };

export function liveResultsPusher(): {
  start(): void;
  stop(): void;
} {
  return {
    start() {},
    stop() {},
  };
}

export async function reconcileEnabledPushers(): Promise<void> {
  // No-op until the re-port lands.
}

export function getDefaultConfig(): LiveResultsConfig {
  return { ...DEFAULT_CONFIG };
}
