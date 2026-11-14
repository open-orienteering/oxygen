/**
 * The instance's enabled DEM providers (docs/map-terrain.md §7.0 answer 4):
 * set once at startup from the environment, replaced by tests with
 * providers over a fake fetch. Empty = no DEM is fetched.
 */

import type { DemProvider } from "./dem-providers.js";

let providers: readonly DemProvider[] = [];

export function setDemProviders(list: readonly DemProvider[]): void {
  providers = [...list];
}

/** In order: Lantmäteriet first, GLO-30 after (§7.0 answer 4). */
export function demProviders(): readonly DemProvider[] {
  return providers;
}

export function demProviderById(id: string): DemProvider | null {
  return providers.find((p) => p.info.id === id) ?? null;
}
