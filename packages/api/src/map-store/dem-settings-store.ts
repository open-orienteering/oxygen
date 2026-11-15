/**
 * The server's DEM settings store and config source (docs/map-terrain.md
 * §7.8), over the real `oxygen_settings` rows. Kept apart from
 * `dem-settings.ts` so the pure module (imported by the providers and the
 * live check's worker) does not load the database client.
 */

import { getSetting, insertSettingIfAbsent, setSetting } from "../db.js";
import { demBaseFetch } from "./dem-providers.js";
import { configureDemConfigSource } from "./dem-registry.js";
import { createDemSettingsStore, type DemSettingsStore } from "./dem-settings.js";

export const demSettingsStore: DemSettingsStore = createDemSettingsStore({ getSetting, setSetting, insertSettingIfAbsent });

/** At startup: the registry reads the saved settings over `env` from now on. */
export function installDemConfigSource(env: NodeJS.ProcessEnv = process.env): void {
  configureDemConfigSource({ load: demSettingsStore.load, env, fetch: demBaseFetch(env) });
}
