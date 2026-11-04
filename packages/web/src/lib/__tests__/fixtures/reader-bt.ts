/**
 * Byte builders for Reader BT protocol tests.
 *
 * Layouts follow https://docs.sportident.com/developers/reader-bt
 * (see docs/si-protocol/reader-bt.md). Everything is little-endian.
 */

import { decodeCp850 } from "../../si-protocol";

export const DAY_MS = 86_400_000;

/** ms since Sunday 00:00 for a weekday index (0=Sun..6=Sat) and h:m:s */
export function weekMs(dayIdx: number, h: number, m: number, s: number, ms = 0): number {
  return dayIdx * DAY_MS + ((h * 60 + m) * 60 + s) * 1000 + ms;
}

export function u16(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff];
}

export function u32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

export function u64(v: number): number[] {
  const lo = v % 2 ** 32;
  const hi = Math.floor(v / 2 ** 32);
  return [...u32(lo), ...u32(hi)];
}

/** CP850, the encoding cards store owner data in (Reader BT charset byte 1) */
export function cp850(s: string): number[] {
  const high = new Map<string, number>();
  for (let b = 0x80; b <= 0xff; b++) {
    const c = decodeCp850(new Uint8Array([b]));
    if (c && !high.has(c)) high.set(c, b);
  }
  return Array.from(s, (c) => {
    const code = c.charCodeAt(0);
    if (code < 0x80) return code;
    const b = high.get(c);
    if (b === undefined) throw new Error(`No CP850 byte for ${c}`);
    return b;
  });
}

export function latin1(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0) & 0xff);
}

export function message(id: number, payload: number[]): Uint8Array {
  return new Uint8Array([...u16(id), ...u16(payload.length), ...payload]);
}

export interface PunchSpec {
  type: number;
  code: number;
  timeMs: number;
  controlInfo?: number;
}

export function punchBytes(p: PunchSpec): number[] {
  return [p.controlInfo ?? 0, p.type, ...u16(p.code), ...u32(p.timeMs)];
}

export interface CardSpec {
  cardNumber: number;
  family: number;
  punches: PunchSpec[];
  /** 13 raw bytes, appended after the punches */
  siacProduction?: number[];
  /** Owner block: charset byte + string bytes, NUL-padded to `ownerSize` */
  owner?: { charset: number; bytes: number[]; size: number };
}

export function cardPayload(spec: CardSpec): number[] {
  const out = [
    ...u32(spec.cardNumber),
    spec.family,
    ...u16(spec.punches.length),
    ...spec.punches.flatMap(punchBytes),
  ];
  if (spec.siacProduction) out.push(...spec.siacProduction);
  if (spec.owner) {
    const str = [...spec.owner.bytes, 0];
    while (str.length < spec.owner.size) str.push(0);
    out.push(spec.owner.charset, ...str);
  }
  return out;
}

/** SIAC production block (13 bytes) */
export function siacProduction(p: {
  hwRaw: number;
  swRaw: number;
  signalCount: number;
  clearCount: number;
  batteryMv: number;
  battery: [number, number, number];
  production: [number, number];
}): number[] {
  return [
    p.hwRaw,
    p.swRaw,
    ...u16(p.signalCount),
    ...u16(p.clearCount),
    ...u16(p.batteryMv),
    ...p.battery,
    ...p.production,
  ];
}

// ─── Shared card fixtures ───────────────────────────────────

/** SI-Card8, complete readout, Monday race, first+last name only */
export const SI8_CARD: CardSpec = {
  cardNumber: 2220164,
  family: 2,
  punches: [
    { type: 1, code: 0, timeMs: weekMs(1, 9, 0, 0) },
    { type: 2, code: 0, timeMs: weekMs(1, 9, 58, 0) },
    { type: 3, code: 0, timeMs: weekMs(1, 10, 0, 0) },
    { type: 7, code: 31, timeMs: weekMs(1, 10, 5, 10) },
    { type: 7, code: 32, timeMs: weekMs(1, 10, 10, 20) },
    { type: 5, code: 0, timeMs: weekMs(1, 10, 30, 45) },
  ],
  owner: { charset: 1, bytes: latin1("Anna;Svensson"), size: 104 },
};

export const SIAC_OWNER =
  "Åsa;Öberg;F;1985;OK Ärla;asa@example.se;+46701234567;Västerås;Storgatan 1;72211;SWE";

/** SIAC in the 8xxxxxx range: production block + 11 owner fields */
export const SIAC_CARD: CardSpec = {
  cardNumber: 8007045,
  family: 15,
  punches: [
    { type: 3, code: 0, timeMs: weekMs(6, 14, 0, 0) },
    { type: 7, code: 101, timeMs: weekMs(6, 14, 3, 7), controlInfo: 0x60 },
    { type: 7, code: 102, timeMs: weekMs(6, 14, 9, 12), controlInfo: 0x80 },
    { type: 5, code: 0, timeMs: weekMs(6, 14, 20, 30) },
  ],
  siacProduction: siacProduction({
    hwRaw: 31,
    swRaw: 64,
    signalCount: 120,
    clearCount: 45,
    batteryMv: 3050,
    battery: [24, 3, 15],
    production: [23, 11],
  }),
  owner: { charset: 1, bytes: cp850(SIAC_OWNER), size: 128 },
};
