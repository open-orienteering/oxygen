/**
 * Decoder for Livelox's custom base64-encoded GPS route data.
 *
 * Encoding: Each character maps to a 6-bit value using the standard base64
 * alphabet. Values are variable-length with an 8-bit header:
 *   - bit 0: if set, multiply decoded value by 1000
 *   - bit 1: if set, value is negative
 *   - bits 2–7: number of data bits that follow
 *
 * Route format:
 *   1. waypointCount
 *   2. For each waypoint: (timeMs, v2, v3) — first is absolute, rest delta-encoded
 *      - Non-projected: v2 = lng×1e6, v3 = lat×1e6
 *      - Projected (EPSG code present): v2 = easting×10, v3 = northing×10
 *   3. interruptionCount
 *   4. For each interruption: waypoint index
 */

import type { ReplayWaypoint } from "@oxygen/shared";

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
const BITS_PER_CHAR = 6;
const HEADER_BITS = 8;

const charToValue: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) {
  charToValue[ALPHABET[i]] = i;
}
charToValue["="] = 0;

class BitReader {
  private bytes: Uint8Array;
  private bitPos = 0;

  constructor(encoded: string) {
    this.bytes = new Uint8Array(encoded.length);
    for (let i = 0; i < encoded.length; i++) {
      this.bytes[i] = charToValue[encoded[i]] ?? 0;
    }
  }

  private getBits(n: number): number {
    let value = 0;
    let bitsLeft = n;
    let byteIdx = Math.floor(this.bitPos / BITS_PER_CHAR);
    let bitOffset = this.bitPos % BITS_PER_CHAR;

    while (bitsLeft > 0) {
      const available = BITS_PER_CHAR - bitOffset;
      const take = Math.min(available, bitsLeft);
      let byte = byteIdx < this.bytes.length ? this.bytes[byteIdx] : 0;
      const mask = (1 << available) - 1;
      byte &= mask;
      const shift = available - take;
      const extracted = byte >> shift;
      // Use multiplication instead of bitwise shift to avoid 32-bit overflow.
      // JS bitwise ops truncate to signed 32-bit; timestamps can exceed 2^31.
      value = value * (1 << take) + extracted;
      bitsLeft -= take;
      bitOffset = 0;
      byteIdx++;
    }

    this.bitPos += n;
    return value;
  }

  read(): number {
    const header = this.getBits(HEADER_BITS);
    const sign = header & 2 ? -1 : 1;
    const multiplier = header & 1 ? 1000 : 1;
    const dataBits = header >> 2;
    if (dataBits === 0) return 0;
    const raw = this.getBits(dataBits);
    return sign * multiplier * raw;
  }
}

export interface DecodedRoute {
  waypoints: ReplayWaypoint[];
  interruptions: number[];
}

/**
 * Decode a Livelox routeData string into waypoints and interruption markers.
 *
 * @param projected If true, route values are projected CRS coords (÷10 = meters).
 *   A `toLatLng` function must be provided to convert them to WGS84.
 * @param toLatLng Converts projected (easting, northing) in meters to {lat, lng}.
 */
export function decodeRouteData(
  encoded: string,
  options?: {
    projected?: boolean;
    toLatLng?: (easting: number, northing: number) => { lat: number; lng: number };
  },
): DecodedRoute {
  if (!encoded) return { waypoints: [], interruptions: [] };

  const projected = options?.projected ?? false;
  const toLatLng = options?.toLatLng;
  const reader = new BitReader(encoded);
  const waypointCount = reader.read();
  const waypoints: ReplayWaypoint[] = [];

  let timeMs = 0;
  let v2 = 0;
  let v3 = 0;

  for (let i = 0; i < waypointCount; i++) {
    if (i === 0) {
      timeMs = reader.read();
      v2 = reader.read();
      v3 = reader.read();
    } else {
      timeMs += reader.read();
      v2 += reader.read();
      v3 += reader.read();
    }

    if (projected && toLatLng) {
      // v2 = easting×10, v3 = northing×10
      const { lat, lng } = toLatLng(v2 / 10, v3 / 10);
      waypoints.push({ timeMs, lat, lng });
    } else {
      // v2 = lng×1e6, v3 = lat×1e6
      waypoints.push({ timeMs, lat: v3 / 1e6, lng: v2 / 1e6 });
    }
  }

  const interruptionCount = reader.read();
  const interruptions: number[] = [];
  for (let i = 0; i < interruptionCount; i++) {
    interruptions.push(reader.read());
  }

  return { waypoints, interruptions };
}
