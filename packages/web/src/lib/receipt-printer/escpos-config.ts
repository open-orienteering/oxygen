/**
 * ESC/POS configuration commands for memory switches and self-test.
 *
 * These commands are documented by Epson in the "GS ( E" and "GS ( A"
 * sections of the ESC/POS Command Reference. Citizen printers (including
 * the CT-S310II) implement the same command framing.
 *
 * Memory switch encoding (per Epson spec, b = 48, 49, 50 = '0', '1', '2'):
 *   - 8 bits per switch, ordered MSB first in both reads and writes:
 *     index 0 = bit 8, index 7 = bit 1.
 *   - In writes, each character is '0' (set OFF), '1' (set ON), or '2'
 *     (leave unchanged). 8 characters per switch.
 *   - In reads, each character is '0' or '1'.
 *
 * Verified against a USB capture of the official Citizen POS Printer
 * Utility writing to a CT-S310II — see docs/printer-mode-management.md.
 *
 * MSW5-3 on the CT-S310II controls USB mode:
 *   - OFF = Virtual COM (PID 0x0FFF, vendor-specific)
 *   - ON  = Printer Class (PID 0x2060, USB class 7)
 *
 * Reference: Citizen CT-S310II User Manual, page 45 (memory switch table).
 *            Epson ESC/POS Command Reference, GS ( E (fn 3 / fn 4 / fn 49).
 */

/** A character used for one bit position in a memory switch write command. */
export type MemorySwitchBit = "0" | "1" | "2";

/** Single-character placeholder meaning "leave this bit unchanged". */
export const MEMORY_SWITCH_NO_CHANGE = "2";

/**
 * Build "GS ( E fn 1" — enter user setting mode.
 * Required wrapper for fn=3 (set memory switch) on many Citizen and Epson
 * firmwares. Printer responds with a 3-byte "mode change notice" via IN.
 */
export function buildEnterUserMode(): Uint8Array {
  return new Uint8Array([
    0x1d, 0x28, 0x45, // GS ( E
    0x03, 0x00,       // pL pH = 3
    0x01,             // fn = 1
    0x49, 0x4e,       // 'I' 'N'
  ]);
}

/**
 * Build "GS ( E fn 2" — exit user setting mode.
 * Saves any changes made since entering user mode and (typically) soft-resets
 * the printer so the new memory switch values take effect.
 */
export function buildExitUserMode(): Uint8Array {
  return new Uint8Array([
    0x1d, 0x28, 0x45, // GS ( E
    0x04, 0x00,       // pL pH = 4
    0x02,             // fn = 2
    0x4f, 0x55, 0x54, // 'O' 'U' 'T'
  ]);
}

/**
 * Build the byte sequence for "GS ( E fn 4" (Transmit memory switch setting).
 * The printer responds via the bulk IN endpoint with an 11-byte packet that
 * can be parsed with parseMemorySwitchResponse.
 */
export function buildReadMemorySwitch(switchNumber: number): Uint8Array {
  assertSwitchNumber(switchNumber);
  return new Uint8Array([
    0x1d, 0x28, 0x45, // GS ( E
    0x02, 0x00,       // pL pH = 2
    0x04,             // fn = 4 (transmit memory switch setting)
    switchNumber,     // a
  ]);
}

/**
 * Parse the 11-byte response to "GS ( E fn 4".
 * Format: 0x37 (header) + 0x21 (identifier) + 8 ASCII '0'/'1' bytes
 * (bit 8 first, bit 1 last) + 0x00 (terminator).
 *
 * Returns the 8 bit values as a string in the same MSB-first order.
 */
export function parseMemorySwitchResponse(bytes: Uint8Array): string {
  const dump = hexDump(bytes);
  if (bytes.length < 11) {
    throw new Error(
      `Memory switch response too short: expected at least 11 bytes, got ${bytes.length} [${dump}]`,
    );
  }
  // Some firmwares prepend or pad the response with extra bytes. Find
  // the first occurrence of the 0x37 0x21 header anywhere in the buffer
  // and parse from there. This is more forgiving than insisting the
  // header is at byte 0.
  const headerIndex = findHeader(bytes);
  if (headerIndex < 0) {
    throw new Error(
      `Invalid memory switch response — no 0x37 0x21 header found in buffer [${dump}]`,
    );
  }
  if (headerIndex + 11 > bytes.length) {
    throw new Error(
      `Memory switch response truncated after header at offset ${headerIndex} [${dump}]`,
    );
  }
  if (bytes[headerIndex + 10] !== 0x00) {
    throw new Error(
      `Invalid memory switch response terminator at offset ${headerIndex + 10}: 0x${bytes[headerIndex + 10]!.toString(16).padStart(2, "0")} [${dump}]`,
    );
  }
  let bits = "";
  for (let i = 2; i < 10; i++) {
    const c = String.fromCharCode(bytes[headerIndex + i]!);
    if (c !== "0" && c !== "1") {
      throw new Error(
        `Invalid bit value at offset ${headerIndex + i}: 0x${bytes[headerIndex + i]!.toString(16)} [${dump}]`,
      );
    }
    bits += c;
  }
  return bits;
}

function findHeader(bytes: Uint8Array): number {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0x37 && bytes[i + 1] === 0x21) return i;
  }
  return -1;
}

function hexDump(bytes: Uint8Array): string {
  return Array.from(bytes)
    .slice(0, 32)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

/**
 * Build the byte sequence for "GS ( E fn 3" (Change memory switch).
 *
 * `bits` is an 8-character string where each char is '0' (set OFF),
 * '1' (set ON), or '2' (leave unchanged). Order is MSB first:
 * index 0 = bit 8, index 7 = bit 1.
 *
 * Use '2' for bits you don't want to change — this avoids race conditions
 * with other settings that may have been changed since the last read.
 */
export function buildWriteMemorySwitch(
  switchNumber: number,
  bits: string,
): Uint8Array {
  assertSwitchNumber(switchNumber);
  if (bits.length !== 8) {
    throw new Error(`bits must be 8 characters long, got ${bits.length}`);
  }
  for (let i = 0; i < 8; i++) {
    const c = bits[i];
    if (c !== "0" && c !== "1" && c !== "2") {
      throw new Error(`bits[${i}] must be '0', '1', or '2', got '${c}'`);
    }
  }
  // Total parameter length = 9*k + 1 where k = 1 (one switch) → pL = 10.
  const out = new Uint8Array(15);
  out[0] = 0x1d; // GS
  out[1] = 0x28; // (
  out[2] = 0x45; // E
  out[3] = 0x0a; // pL = 10
  out[4] = 0x00; // pH
  out[5] = 0x03; // fn = 3 (change memory switch)
  out[6] = switchNumber; // a
  for (let i = 0; i < 8; i++) {
    out[7 + i] = bits.charCodeAt(i);
  }
  return out;
}

/**
 * Build the byte sequence for setting a single bit within a memory switch
 * to either OFF or ON, leaving every other bit in that switch unchanged.
 *
 * `bitNumber` is 1–8 in the printer's documented numbering (e.g. MSW5-3
 * has bitNumber=3). Internally translated to the MSB-first index used
 * by the wire format.
 */
export function buildWriteMemorySwitchBit(
  switchNumber: number,
  bitNumber: number,
  value: "0" | "1",
): Uint8Array {
  if (bitNumber < 1 || bitNumber > 8 || !Number.isInteger(bitNumber)) {
    throw new Error(`bitNumber must be an integer 1-8, got ${bitNumber}`);
  }
  // bit N (1..8) lives at MSB-first index (8 - N).
  const index = 8 - bitNumber;
  const bits =
    MEMORY_SWITCH_NO_CHANGE.repeat(index) +
    value +
    MEMORY_SWITCH_NO_CHANGE.repeat(7 - index);
  return buildWriteMemorySwitch(switchNumber, bits);
}

// ── CT-S310II USB mode ─────────────────────────────────────────

export type CitizenUsbMode = "virtual-com" | "printer-class";

/** MSW5-3 controls USB mode on the CT-S310II. */
export const CITIZEN_USB_MODE_SWITCH = 5;
export const CITIZEN_USB_MODE_BIT = 3;

/**
 * Build the byte sequence to flip the CT-S310II's USB mode.
 * Only MSW5-3 is changed; every other bit in SW5 is left untouched.
 *
 * The change takes effect after a power cycle (USB re-enumeration).
 */
export function buildFlashUsbMode(mode: CitizenUsbMode): Uint8Array {
  const value = mode === "virtual-com" ? "0" : "1";
  return buildWriteMemorySwitchBit(
    CITIZEN_USB_MODE_SWITCH,
    CITIZEN_USB_MODE_BIT,
    value,
  );
}

/**
 * Decode the USB mode from a memory switch read of SW5.
 * `switchBits` is the 8-char MSB-first string from parseMemorySwitchResponse.
 */
export function parseUsbModeFromSwitch5(switchBits: string): CitizenUsbMode {
  if (switchBits.length !== 8) {
    throw new Error(`switchBits must be 8 characters, got ${switchBits.length}`);
  }
  // MSW5-3 lives at MSB-first index 5 (= 8 - 3).
  const bit3 = switchBits[8 - CITIZEN_USB_MODE_BIT];
  return bit3 === "0" ? "virtual-com" : "printer-class";
}

// ── Self-test ──────────────────────────────────────────────────

/**
 * Build the byte sequence for the printer's built-in self-test.
 * Sends "GS ( A pL pH n m" with n=0 (next power-on test) m=2 (rolling
 * pattern + memory switch dump on Citizen models).
 */
export function buildSelfTest(): Uint8Array {
  return new Uint8Array([0x1d, 0x28, 0x41, 0x02, 0x00, 0x00, 0x02]);
}

// ── helpers ───────────────────────────────────────────────────

function assertSwitchNumber(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > 10) {
    throw new Error(`switchNumber must be an integer 1-10, got ${n}`);
  }
}
