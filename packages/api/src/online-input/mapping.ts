/**
 * Control mapping for online-input punches.
 *
 * Some installations want a specific raw control code (e.g. 100) to act as
 * a Start, Finish or Check punch in `oPunch.Type`. MeOS exposes the same
 * feature via "Kontrollmappning" in the Online Input settings dialog
 * (see `code/onlineinput.cpp:274` / `controlMappingView`).
 *
 * Storage: a single JSON row per competition in `oxygen_settings`,
 *
 *   online_input_mapping_<nameId> = {"100": 1, "200": 2}
 *
 * Values are the MeOS `oPunch::SpecialPunch` enum from `oPunch.h:118`:
 *
 *   PunchUnused = 0   (treated as "no mapping")
 *   PunchStart  = 1
 *   PunchFinish = 2
 *   PunchCheck  = 3
 */

import { getSetting, setSetting } from "../db.js";

export const PUNCH_START = 1;
export const PUNCH_FINISH = 2;
export const PUNCH_CHECK = 3;

export type SpecialPunch = typeof PUNCH_START | typeof PUNCH_FINISH | typeof PUNCH_CHECK;

export type ControlMapping = Record<string, SpecialPunch>;

const MAPPING_PREFIX = "online_input_mapping_";

export function mappingKey(nameId: string): string {
  return `${MAPPING_PREFIX}${nameId}`;
}

/** Load the persisted mapping. Empty object if none stored or stored value is invalid. */
export async function loadMapping(nameId: string): Promise<ControlMapping> {
  const raw = await getSetting(mappingKey(nameId));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ControlMapping = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const code = parseInt(k, 10);
      if (!Number.isFinite(code) || code <= 0) continue;
      if (v === PUNCH_START || v === PUNCH_FINISH || v === PUNCH_CHECK) {
        out[String(code)] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist the mapping (overwrites any existing value). */
export async function saveMapping(nameId: string, mapping: ControlMapping): Promise<void> {
  await setSetting(mappingKey(nameId), JSON.stringify(mapping));
}

export async function addMapping(
  nameId: string,
  rawCode: number,
  target: SpecialPunch,
): Promise<ControlMapping> {
  if (!Number.isFinite(rawCode) || rawCode <= 0 || rawCode >= 1024) {
    throw new Error(`Invalid control code: ${rawCode}`);
  }
  const current = await loadMapping(nameId);
  current[String(rawCode)] = target;
  await saveMapping(nameId, current);
  return current;
}

export async function removeMapping(nameId: string, rawCode: number): Promise<ControlMapping> {
  const current = await loadMapping(nameId);
  delete current[String(rawCode)];
  await saveMapping(nameId, current);
  return current;
}

/**
 * Apply the mapping to a raw control code. Returns the special-punch type
 * if the code is mapped, otherwise the raw code unchanged.
 */
export function applyMapping(mapping: ControlMapping, rawCode: number): number {
  return mapping[String(rawCode)] ?? rawCode;
}
