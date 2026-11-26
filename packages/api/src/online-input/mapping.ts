/**
 * Control mapping for online-input punches.
 *
 * Some installations want a specific raw control code (e.g. 100) to act as
 * a Start, Finish or Check punch in `oPunch.Type`. MeOS exposes the same
 * feature via "Kontrollmappning" in the Online Input settings dialog
 * (see `code/onlineinput.cpp:274` / `controlMappingView`).
 *
 * Storage: the `mapping` field of the event's online-input config,
 *
 *   online_input_<eventId>_config = {..., "mapping": {"100": 2}, ...}
 *
 * written by `onlineInput.addMapping` / `removeMapping` and read by the
 * puller on every poll.
 *
 * Values are the MeOS `oPunch::SpecialPunch` enum from `oPunch.h:118`:
 *
 *   PunchUnused = 0   (treated as "no mapping")
 *   PunchStart  = 1
 *   PunchFinish = 2
 *   PunchCheck  = 3
 */

export const PUNCH_START = 1;
export const PUNCH_FINISH = 2;
export const PUNCH_CHECK = 3;

export type SpecialPunch = typeof PUNCH_START | typeof PUNCH_FINISH | typeof PUNCH_CHECK;

export type ControlMapping = Record<string, SpecialPunch>;

/**
 * Keep only valid entries of a stored mapping: positive integer codes that
 * map to start, finish or check. Anything else (a hand-edited settings row,
 * an older shape) is dropped rather than applied.
 */
export function sanitizeMapping(raw: unknown): ControlMapping {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ControlMapping = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(k)) continue;
    const code = Number(k);
    if (code <= 0) continue;
    if (v === PUNCH_START || v === PUNCH_FINISH || v === PUNCH_CHECK) {
      out[String(code)] = v;
    }
  }
  return out;
}

/**
 * Apply the mapping to a raw control code. Returns the special-punch type
 * if the code is mapped, otherwise the raw code unchanged.
 */
export function applyMapping(mapping: ControlMapping, rawCode: number): number {
  return mapping[String(rawCode)] ?? rawCode;
}
