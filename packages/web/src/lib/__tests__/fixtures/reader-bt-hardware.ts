/**
 * Frames captured from a real Reader BT (firmware 2.2.0, serial 1000139)
 * reading a SIAC, November 2026. The owner block is replaced with made-up
 * data; everything before it is byte for byte what the reader sent.
 */

import { cp850, message, u32 } from "./reader-bt";

const bytes = (hex: string) => hex.trim().split(/\s+/).map((b) => parseInt(b, 16));

/** ReadDeviceInfo response notification (software string NUL-padded to 116 bytes) */
export const HW_DEVICE_INFO = new Uint8Array(
  bytes(`0e 01 74 00 cb 42 0f 00 a7 00 04 01 ea 07 0a 02 ea 07 0a 02
    73 69 72 65 61 64 65 72 40 32 2e 32 2e 30 2b 37 31 66 38 39 66 66 2e 32 30 32 36 31 30 30 38 31 31 33 37 33 38`).concat(
    new Array(116 - 52).fill(0),
  ),
);

/** ReadAllSettings response: code 5, readout mode */
export const HW_SETTINGS = new Uint8Array(bytes("0c 01 0a 00 05 00 05 00 00 00 00 00 00 00"));

/** CardStateChange: SIAC 8007045 inserted at code 5 */
export const HW_CARD_IN = new Uint8Array(bytes("01 11 07 00 85 2d 7a 00 01 05 00"));

/** 0x1103 payload up to and including the SIAC production block */
const HW_SIAC_CARD_PREFIX = bytes(`85 2d 7a 00 0f 16 00
  07 02 01 00 a8 cf 35 02  1a 01 01 00 68 c2 32 02  03 03 04 00 08 01 40 02  03 04 04 00 08 01 40 02
  74 05 00 00 f7 fa 82 02  74 06 00 00 f7 fa 82 02  32 07 90 00 df 51 44 02  32 07 82 00 10 32 47 02
  32 07 5d 00 71 db 4a 02  32 07 84 00 92 88 53 02  32 07 8f 00 5b 0d 58 02  32 07 8d 00 87 cc 5e 02
  32 07 8e 00 ca 2a 62 02  32 07 8c 00 34 d6 63 02  32 07 97 00 f3 e9 67 02  32 07 99 00 0a 3b 6b 02
  32 07 95 00 a6 2b 72 02  32 07 78 00 20 08 78 02  32 07 3f 00 4f 21 7a 02  32 07 38 00 57 a6 7d 02
  72 07 3d 00 31 67 80 02  32 07 64 00 0a c7 82 02
  10 2b f8 03 36 00 a4 0b 18 02 0c 18 02`);

export const HW_SIAC_OWNER =
  "Åsa;Öberg;male;19850314;OK Ärla;asa@example.se;0046701234567;Västerås;Storgatan 1;72211;Swedish;";

/** The complete 0x1103 message (owner block: charset 1, CP850, NUL-padded) */
export const HW_SIAC_MESSAGE = message(
  0x1103,
  [...HW_SIAC_CARD_PREFIX, 1, ...cp850(HW_SIAC_OWNER), ...new Array(9).fill(0)],
);

/**
 * Split like the reader does at this MTU: 0xA101 notifications of at most
 * 244 payload bytes (`01 a1 f4 00 01 <u32 total> …`, then `01 a1 … 02 …`).
 */
export function hwSegments(msg: Uint8Array, maxPayload = 244): Uint8Array[] {
  const out: Uint8Array[] = [];
  let off = 0;
  let first = true;
  while (off < msg.length) {
    const room = maxPayload - (first ? 5 : 1);
    const part = Array.from(msg.subarray(off, off + room));
    off += part.length;
    const flag = first ? 0x01 : off >= msg.length ? 0x02 : 0x00;
    out.push(message(0xa101, first ? [flag, ...u32(msg.length), ...part] : [flag, ...part]));
    first = false;
  }
  return out;
}
