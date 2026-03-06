/**
 * SportIdent Protocol Library
 *
 * Pure TypeScript implementation of the SI protocol for WebSerial communication.
 * Ported from start-helper/js/si-protocol.js and sportident-python/sireader2.py.
 *
 * Supports: SI5/SI6 detection, SI8/SI9/SI10/SI11/SIAC/pCard/tCard full readout.
 */

// ─── Constants ─────────────────────────────────────────────

export const STX = 0x02;
export const ETX = 0x03;
export const ACK = 0x06;
export const NAK = 0x15;
export const WAKEUP = 0xff;

/** SI command bytes */
export const CMD = {
  GET_SYSTEM_VALUE: 0x83,
  SET_SYSTEM_VALUE: 0x82,
  GET_BACKUP: 0x81,
  SET_MS_MODE: 0x70,
  SET_MS: 0xf0,
  GET_MS: 0xf1,
  SET_TIME: 0xf6,
  GET_TIME: 0xf7,
  ERASE_BACKUP: 0xf5,
  OFF: 0xf8,
  BEEP: 0xf9,

  // Card detection (station → host)
  SI5_DETECTED: 0xe5,
  SI6_DETECTED: 0xe6,
  CARD_REMOVED: 0xe7,
  SI8_DETECTED: 0xe8, // also SI9/10/11/SIAC/pCard/tCard

  // Card readout
  SI5_READ: 0xb1,
  SI6_READ: 0xe1,
  SI8_READ: 0xef, // also SI9/10/11/SIAC/pCard/tCard

  // Card write (used for triggering SIAC battery measurement)
  SI9_WRITE: 0xea,

  // Punch transmission (online control / SRR)
  TRANSMIT_RECORD: 0xd3,
  SRR_PUNCH: 0x53,
} as const;

/** Special control codes in MeOS punch data */
export const SPECIAL_CN = {
  CHECK: 1,
  START: 2,
  FINISH: 3,
  CLEAR: 4,
} as const;

/** Time sentinel for "no time" */
const NO_TIME = 0xeeee;

// ─── Card types ────────────────────────────────────────────

export type SICardType =
  | "SI5"
  | "SI6"
  | "SI8"
  | "SI9"
  | "SI10"
  | "SI11"
  | "SIAC"
  | "pCard"
  | "tCard"
  | "Unknown";

/** Number of 128-byte blocks to read per card type */
export const BLOCKS_TO_READ: Record<string, number> = {
  SI8: 2,
  SI9: 2,
  pCard: 2,
  tCard: 2,
  SI10: 8,
  SI11: 8,
  SIAC: 8,
};

export function getCardType(cardNumber: number): SICardType {
  if (cardNumber < 1) return "Unknown";
  if (cardNumber <= 499999) return "SI5";
  if (cardNumber <= 999999) return "SI6";
  if (cardNumber <= 1999999) return "SI9";
  // SI6 special range must be checked before SI8
  if (cardNumber >= 2003001 && cardNumber <= 2003400) return "SI6";
  if (cardNumber >= 2000001 && cardNumber <= 2999999) return "SI8";
  if (cardNumber >= 4000000 && cardNumber <= 4999999) return "pCard";
  if (cardNumber >= 6000001 && cardNumber <= 6999999) return "tCard";
  if (cardNumber >= 7000001 && cardNumber <= 7999999) return "SI10";
  if (cardNumber >= 8000001 && cardNumber <= 8999999) return "SIAC";
  if (cardNumber >= 9000001 && cardNumber <= 9999999) return "SIAC";
  if (cardNumber >= 14000001 && cardNumber <= 16999999) return "SIAC";
  return "Unknown";
}

/** Can we do a full block readout for this card type? */
export function supportsFullReadout(cardType: SICardType): boolean {
  return cardType in BLOCKS_TO_READ;
}

// ─── CRC ───────────────────────────────────────────────────

/**
 * CRC-16 with polynomial 0x8005, as used by the SI protocol.
 * Input: the bytes to checksum (CMD + LEN + DATA).
 */
export function calculateCRC(data: Uint8Array): number {
  if (!data || data.length < 2) return 0;

  let idx = 0;
  let crc = (data[idx] << 8) + data[idx + 1];
  idx += 2;

  if (data.length === 2) return crc;

  const count = data.length;
  for (let k = Math.floor(count / 2); k > 0; k--) {
    let value: number;
    if (k > 1) {
      value = (data[idx] << 8) + data[idx + 1];
      idx += 2;
    } else {
      // Odd length: pad last byte with 0
      value = count & 1 ? data[idx] << 8 : 0;
    }

    for (let j = 0; j < 16; j++) {
      if (crc & 0x8000) {
        crc = (crc << 1) & 0xffff;
        if (value & 0x8000) crc++;
        crc ^= 0x8005;
      } else {
        crc = (crc << 1) & 0xffff;
        if (value & 0x8000) crc++;
      }
      value = (value << 1) & 0xffff;
    }
  }

  return crc & 0xffff;
}

// ─── Frame building ────────────────────────────────────────

/**
 * Build a command frame to send to the SI station.
 * Format: WAKEUP + STX + CMD + LEN + PARAMS + CRC(2) + ETX
 *
 * @param skipWakeup — omit the 0xFF wakeup prefix. Required when the BSM8
 *   is in remote mode — the wakeup byte gets misinterpreted and causes NAK.
 */
export function buildCommand(cmd: number, params: number[] = [], skipWakeup = false): Uint8Array {
  const len = params.length;
  const prefixLen = skipWakeup ? 0 : 1;
  const frame = new Uint8Array(6 + prefixLen + len);
  let idx = 0;
  if (!skipWakeup) frame[idx++] = WAKEUP;
  frame[idx++] = STX;
  frame[idx] = cmd;
  frame[idx + 1] = len;
  for (let i = 0; i < len; i++) frame[idx + 2 + i] = params[i];

  // CRC over CMD + LEN + PARAMS
  const crcData = frame.slice(idx, idx + 2 + len);
  const crc = calculateCRC(crcData);
  frame[idx + 2 + len] = (crc >> 8) & 0xff;
  frame[idx + 3 + len] = crc & 0xff;
  frame[idx + 4 + len] = ETX;
  return frame;
}

/**
 * Build the read-card command(s) for a given card type and block number.
 */
export function buildReadCommand(
  cardType: SICardType,
  blockNumber: number,
): Uint8Array {
  let cmd: number;
  switch (cardType) {
    case "SI5":
      cmd = CMD.SI5_READ;
      break;
    case "SI6":
      cmd = CMD.SI6_READ;
      break;
    default:
      cmd = CMD.SI8_READ;
      break;
  }
  return buildCommand(cmd, [blockNumber]);
}

// ─── Frame parsing ─────────────────────────────────────────

export interface SIParsedFrame {
  cmd: number;
  data: Uint8Array;
  isExtended: boolean;
  crcValid: boolean;
}

/**
 * Try to extract one complete frame from a byte buffer.
 * Returns the parsed frame + remaining bytes, or null if no complete frame found.
 */
export function extractFrame(
  buffer: Uint8Array,
): { frame: SIParsedFrame; remaining: Uint8Array } | null {
  // Find STX
  let stxIdx = -1;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === STX) {
      stxIdx = i;
      break;
    }
  }
  if (stxIdx === -1) return null;
  const buf = buffer.subarray(stxIdx);

  // Need at least STX + CMD + LEN = 3 bytes
  if (buf.length < 3) return null;

  const isExtended = buf[1] === 0xff;

  if (isExtended) {
    // Extended: STX + FF + CMD + LEN + DATA(LEN) + CRC(2) [+ ETX]
    if (buf.length < 4) return null;
    const cmd = buf[2];
    const len = buf[3];
    const frameLen = 4 + len + 2; // STX+FF+CMD+LEN + DATA + CRC
    if (buf.length < frameLen) return null;

    const data = buf.slice(4, 4 + len);
    const crcData = buf.slice(2, 4 + len); // CMD+LEN+DATA
    const calcCrc = calculateCRC(crcData);
    const recvCrc = (buf[4 + len] << 8) | buf[5 + len];

    // Consume optional ETX
    const consumed = buf.length > frameLen && buf[frameLen] === ETX ? frameLen + 1 : frameLen;
    return {
      frame: { cmd, data, isExtended: true, crcValid: calcCrc === recvCrc },
      remaining: buffer.subarray(stxIdx + consumed),
    };
  }

  // BSF8: STX + CMD + LEN + DATA(LEN) + CRC(2) + ETX
  const cmd = buf[1];
  const len = buf[2];
  const frameLen = 3 + len + 2 + 1; // STX+CMD+LEN + DATA + CRC + ETX
  if (buf.length < frameLen) return null;

  // Verify ETX
  if (buf[frameLen - 1] !== ETX) {
    // Corrupted — skip this STX and try again
    const rest = buffer.subarray(stxIdx + 1);
    return extractFrame(rest);
  }

  const data = buf.slice(3, 3 + len);
  const crcData = buf.slice(1, 3 + len); // CMD+LEN+DATA
  const calcCrc = calculateCRC(crcData);
  const recvCrc = (buf[3 + len] << 8) | buf[4 + len];

  return {
    frame: { cmd, data, isExtended: false, crcValid: calcCrc === recvCrc },
    remaining: buffer.subarray(stxIdx + frameLen),
  };
}

// ─── Card detection parsing ────────────────────────────────

export interface SICardDetection {
  cardNumber: number;
  cardType: SICardType;
}

/**
 * Parse a card detection event from its command + data.
 */
export function parseCardDetection(
  cmd: number,
  data: Uint8Array,
): SICardDetection | null {
  if (cmd === CMD.SI5_DETECTED) return parseSI5Detection(data);
  if (cmd === CMD.SI6_DETECTED) return parseSI6Detection(data);
  if (cmd === CMD.SI8_DETECTED) return parseSI8Detection(data);
  return null;
}

function parseSI5Detection(data: Uint8Array): SICardDetection | null {
  if (data.length < 2) return null;
  let cardNumber = (data[0] << 8) | data[1];
  if (data.length >= 3) {
    const series = data[2];
    if (series >= 1 && series <= 4) cardNumber = series * 100000 + cardNumber;
  }
  return { cardNumber, cardType: getCardType(cardNumber) };
}

function parseSI6Detection(data: Uint8Array): SICardDetection | null {
  if (data.length < 4) return null;
  let cardNumber: number;
  if (data.length >= 6) {
    cardNumber =
      ((data[2] << 24) | (data[3] << 16) | (data[4] << 8) | data[5]) &
      0xffffff;
  } else {
    cardNumber = (data[1] << 16) | (data[2] << 8) | data[3];
  }
  return { cardNumber, cardType: getCardType(cardNumber) };
}

function parseSI8Detection(data: Uint8Array): SICardDetection | null {
  if (data.length < 4) return null;
  let cardNumber: number;
  if (data.length >= 6) {
    // stationCode(2) + seriesByte(1) + cardNumber(3)
    cardNumber = (data[3] << 16) | (data[4] << 8) | data[5];
  } else {
    cardNumber = (data[1] << 16) | (data[2] << 8) | data[3];
  }
  return { cardNumber, cardType: getCardType(cardNumber) };
}

// ─── Punch parsing ─────────────────────────────────────────

export interface SIPunch {
  controlCode: number;
  /** Seconds since midnight */
  time: number;
}

/**
 * Parse a 2-byte time from SI card memory.
 *
 * The raw 16-bit value (PTH << 8 | PTL) represents seconds since midnight/noon
 * (within a 12-hour window, 0–43199). The AM/PM flag lives in the PTD byte,
 * which is always 2 bytes before the time bytes in the 4-byte record format:
 *   PTD(1) + CN(1) + PTH(1) + PTL(1)
 *
 * This applies to both special times (check/start/finish/clear) and punch records.
 */
export function parsePunchTime(
  data: Uint8Array,
  offset: number,
): number | null {
  if (offset + 2 > data.length) return null;
  const raw = (data[offset] << 8) | data[offset + 1];
  if (raw === NO_TIME) return null;
  // PM flag is in the PTD byte, 2 positions before the time bytes
  const isPM = offset >= 2 ? (data[offset - 2] & 0x01) !== 0 : false;
  return isPM ? raw + 43200 : raw;
}

/**
 * Parse a 4-byte SI8+ punch record at the given offset.
 * Format: PTD(1) + CN(1) + TimeH(1) + TimeL(1)
 * Station code = ((PTD & 0xC0) << 2) | CN
 */
export function parsePunchRecord(
  data: Uint8Array,
  offset: number,
): SIPunch | null {
  if (offset + 4 > data.length) return null;
  const ptd = data[offset];
  const cn = data[offset + 1];
  const controlCode = ((ptd & 0xc0) << 2) | cn;
  if (controlCode === 0) return null;

  const time = parsePunchTime(data, offset + 2);
  if (time === null) return null;

  return { controlCode, time };
}

// ─── CP850 decoding ────────────────────────────────────────

/**
 * CP850 (IBM850) high-byte-to-Unicode lookup for bytes 0x80–0xFF.
 * Essential for Scandinavian names (å,ä,ö,ø,æ etc.) stored on SI cards.
 */
const CP850_HIGH: string =
  "ÇüéâäàåçêëèïîìÄÅ" + // 0x80-0x8F
  "ÉæÆôöòûùÿÖÜø£Ø×ƒ" + // 0x90-0x9F
  "áíóúñÑªº¿®¬½¼¡«»" + // 0xA0-0xAF
  "░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐" + // 0xB0-0xBF
  "└┴┬├─┼ãÃ╚╔╩╦╠═╬¤" + // 0xC0-0xCF
  "ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀" + // 0xD0-0xDF
  "ÓßÔÒõÕµþÞÚÛÙýÝ¯´" + // 0xE0-0xEF
  "\u00AD±‗¾¶§÷¸°¨·¹³²■\u00A0"; // 0xF0-0xFF

/**
 * Decode a CP850-encoded byte array to a Unicode string.
 * Stops at 0x00 or 0xEE (SI "no data" sentinel).
 */
export function decodeCp850(data: Uint8Array, start = 0, end?: number): string {
  const limit = end ?? data.length;
  let out = "";
  for (let i = start; i < limit; i++) {
    const b = data[i];
    if (b === 0x00 || b === 0xee) break;
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else {
      out += CP850_HIGH[b - 0x80];
    }
  }
  return out;
}

// ─── Personal data parsing ─────────────────────────────────

/**
 * Owner data stored on SI10/SIAC/SI11 cards.
 * Fields are semicolon-separated CP850 text starting at block 0 offset 32,
 * continuing through blocks 1-3.
 */
export interface SICardOwnerData {
  firstName?: string;
  lastName?: string;
  sex?: string;
  dateOfBirth?: string;
  club?: string;
  email?: string;
  phone?: string;
  city?: string;
  street?: string;
  postcode?: string;
  country?: string;
}

/** Field order in the semicolon-separated personal data area */
const PERSONAL_FIELDS = [
  "firstName",
  "lastName",
  "sex",
  "dateOfBirth",
  "club",
  "email",
  "phone",
  "city",
  "street",
  "postcode",
  "country",
] as const;

/**
 * Parse personal data from SI10/SIAC/SI11 card blocks.
 *
 * Memory layout: personal data starts at block 0 offset 32 and continues
 * through blocks 1-3 as semicolon-separated CP850 text, terminated by 0xEE.
 *
 * @param blocks Array of 128-byte blocks (must include blocks 0-3 for full data)
 */
export function parseSI10PersonalData(
  blocks: Uint8Array[],
): SICardOwnerData | null {
  if (blocks.length === 0 || blocks[0].length < 128) return null;

  // Concatenate the personal data area: block0[32..127] + block1[0..127] + ...
  // Maximum personal data area = 96 + 128*3 = 480 bytes
  const parts: number[] = [];
  for (let bi = 0; bi < Math.min(blocks.length, 4); bi++) {
    const block = blocks[bi];
    const start = bi === 0 ? 32 : 0;
    for (let i = start; i < block.length; i++) {
      if (block[i] === 0xee) {
        // End of personal data
        break;
      }
      parts.push(block[i]);
    }
    // If we hit 0xEE in the inner loop, stop outer loop too
    if (block.length > 0) {
      const lastStart = bi === 0 ? 32 : 0;
      let hitTerminator = false;
      for (let i = lastStart; i < block.length; i++) {
        if (block[i] === 0xee) {
          hitTerminator = true;
          break;
        }
      }
      if (hitTerminator) break;
    }
  }

  if (parts.length === 0) return null;

  // Decode the concatenated bytes as CP850
  const raw = new Uint8Array(parts);
  const text = decodeCp850(raw);
  if (!text.trim()) return null;

  const segments = text.split(";");
  const result: Record<string, string> = {};

  for (let i = 0; i < PERSONAL_FIELDS.length && i < segments.length; i++) {
    const val = segments[i].trim();
    if (val) {
      result[PERSONAL_FIELDS[i]] = val;
    }
  }

  return Object.keys(result).length > 0 ? (result as SICardOwnerData) : null;
}

// ─── SIAC / SI10 card metadata ──────────────────────────────

/** Metadata from SIAC/SI10/SI11 block 3 (battery, production, HW/SW) */
export interface SICardMetadata {
  /** Battery date (when battery was inserted) */
  batteryDate?: string; // ISO date YYYY-MM-DD
  /** Production date */
  productionDate?: string; // ISO date YYYY-MM-DD
  /** Hardware version (e.g. "3.12") */
  hardwareVersion?: string;
  /** Software version (e.g. "6.22") */
  softwareVersion?: string;
  /** Total number of card clears */
  clearCount?: number;
}

/**
 * Parse SIAC/SI10 metadata from block 3.
 * Layout (from sportident-python si_read_card.py):
 *   - Offset 48:     sentinel (0xEE = no data)
 *   - Offset 60-62:  Battery date (YY, MM, DD)
 *   - Offset 63:     Production day (same year/month as battery)
 *   - Offset 64-65:  Hardware version (major.minor)
 *   - Offset 66-67:  Software version (major.minor)
 *   - Offset 71:     Battery voltage raw byte
 *   - Offset 72-73:  Clear count (16-bit big-endian)
 */
export function parseSI10Metadata(block3: Uint8Array): SICardMetadata | null {
  if (block3.length < 74) return null;

  // Check sentinel at offset 48 — 0xEE means no metadata
  if (block3[48] === 0xee) return null;

  const meta: SICardMetadata = {};

  // Battery date (offset 60-62)
  const batYear = 2000 + block3[60];
  const batMonth = block3[61];
  const batDay = block3[62];
  if (batMonth >= 1 && batMonth <= 12 && batDay >= 1 && batDay <= 31) {
    meta.batteryDate = `${batYear}-${String(batMonth).padStart(2, "0")}-${String(batDay).padStart(2, "0")}`;
  }

  // Production date (offset 63 = day, same year/month as battery)
  const prodDay = block3[63];
  if (prodDay >= 1 && prodDay <= 31 && batMonth >= 1 && batMonth <= 12) {
    meta.productionDate = `${batYear}-${String(batMonth).padStart(2, "0")}-${String(prodDay).padStart(2, "0")}`;
  }

  // Hardware version (offset 64-65)
  const hwMajor = block3[64];
  const hwMinor = block3[65];
  if (hwMajor < 20) {
    meta.hardwareVersion = `${hwMajor}.${hwMinor}`;
  }

  // Software version (offset 66-67)
  const swMajor = block3[66];
  const swMinor = block3[67];
  if (swMajor < 20) {
    meta.softwareVersion = `${swMajor}.${swMinor}`;
  }

  // Clear count (offset 72-73, big-endian)
  meta.clearCount = (block3[72] << 8) | block3[73];

  return meta;
}

// ─── SI8+ card data parsing ────────────────────────────────

export interface SICardReadout {
  cardNumber: number;
  cardType: SICardType;
  checkTime: number | null;
  startTime: number | null;
  finishTime: number | null;
  clearTime: number | null;
  punches: SIPunch[];
  punchCount: number;
  /** Owner data from the card (SI10/SIAC/SI11 only) */
  ownerData?: SICardOwnerData | null;
  /** Battery voltage in volts (SIAC only) */
  batteryVoltage?: number | null;
  /** Card metadata: battery date, production date, HW/SW version, etc. */
  metadata?: SICardMetadata | null;
}

/**
 * Check if a card type uses the "large card" memory layout
 * (SI10/SI11/SIAC: personal data in blocks 0-3, punches in blocks 4-7).
 */
export function isLargeCardType(cardType: SICardType): boolean {
  return cardType === "SI10" || cardType === "SI11" || cardType === "SIAC";
}

/**
 * Parse SI8/SI9/pCard/tCard card data from readout blocks.
 * These cards have punches starting at block 0 offset 32.
 *
 * Block 0 layout (SI8/SI9):
 *   [4-7]   Clear station + time
 *   [8-11]  Check station + time
 *   [12-15] Start station + time
 *   [16-19] Finish station + time
 *   [22]    Number of punches
 *   [24]    Card series byte (0x02=SI8, 0x01=SI9, etc.)
 *   [25-27] Card number (3 bytes, big-endian)
 *   [32+]   Punch records (4 bytes each, up to 24 in block 0)
 *
 * Block 1+: Punch records (32 per block)
 */
export function parseSI8CardData(blocks: Uint8Array[]): SICardReadout | null {
  if (blocks.length === 0 || blocks[0].length < 128) return null;

  const b0 = blocks[0];

  // Card number: 3 bytes at offset 25-27 (offset 24 is the series byte)
  let cn = (b0[25] << 16) | (b0[26] << 8) | b0[27];
  if (cn === 0) {
    cn = (b0[24] << 16) | (b0[25] << 8) | b0[26];
    if (cn === 0) return null;
  }

  const cardType = getCardType(cn);
  const punchCount = b0[22];

  const clearTime = parsePunchTime(b0, 6);
  const checkTime = parsePunchTime(b0, 10);
  const startTime = parsePunchTime(b0, 14);
  const finishTime = parsePunchTime(b0, 18);

  // Parse punches — SI8: block 0 offset 32, then block 1+ offset 0
  const punches: SIPunch[] = [];
  for (let bi = 0; bi < blocks.length && punches.length < punchCount; bi++) {
    const block = blocks[bi];
    const startOffset = bi === 0 ? 32 : 0;
    const punchesInBlock = Math.floor((block.length - startOffset) / 4);

    for (
      let pi = 0;
      pi < punchesInBlock && punches.length < punchCount;
      pi++
    ) {
      const offset = startOffset + pi * 4;
      const punch = parsePunchRecord(block, offset);
      if (punch) {
        punches.push(punch);
      }
    }
  }

  return {
    cardNumber: cn,
    cardType,
    checkTime,
    startTime,
    finishTime,
    clearTime,
    punches,
    punchCount,
  };
}

/**
 * Parse SI10/SI11/SIAC card data from readout blocks.
 * These "large" cards have a different memory layout:
 *
 *   Block 0:   Header (same offsets as SI8 for CN/times) + personal data starts at offset 32
 *   Blocks 1-3: Personal data continuation + card metadata
 *   Blocks 4-7: Punch records (4 bytes each, 32 punches per block, up to 128 total)
 *
 * @param allBlocks Array of blocks in order [block0, block1, block2, block3, block4, ...]
 */
export function parseSI10CardData(
  allBlocks: Uint8Array[],
): SICardReadout | null {
  if (allBlocks.length === 0 || allBlocks[0].length < 128) return null;

  const b0 = allBlocks[0];

  // Card number: same layout as SI8
  let cn = (b0[25] << 16) | (b0[26] << 8) | b0[27];
  if (cn === 0) {
    cn = (b0[24] << 16) | (b0[25] << 8) | b0[26];
    if (cn === 0) return null;
  }

  const cardType = getCardType(cn);
  const punchCount = b0[22];

  const clearTime = parsePunchTime(b0, 6);
  const checkTime = parsePunchTime(b0, 10);
  const startTime = parsePunchTime(b0, 14);
  const finishTime = parsePunchTime(b0, 18);

  // Parse personal data from blocks 0-3
  const personalBlocks = allBlocks.slice(0, Math.min(allBlocks.length, 4));
  const ownerData = parseSI10PersonalData(personalBlocks);

  // Parse punches from blocks 4+ (each block holds 32 punches at 4 bytes each)
  const punches: SIPunch[] = [];
  for (
    let bi = 4;
    bi < allBlocks.length && punches.length < punchCount;
    bi++
  ) {
    const block = allBlocks[bi];
    const punchesInBlock = Math.floor(block.length / 4);
    for (
      let pi = 0;
      pi < punchesInBlock && punches.length < punchCount;
      pi++
    ) {
      const punch = parsePunchRecord(block, pi * 4);
      if (punch) {
        punches.push(punch);
      }
    }
  }

  // Extract battery voltage from block 3, offset 71 (SIAC only).
  // The raw byte encodes voltage as: V = 1.9 + raw * 0.09
  // This may be from a previous measurement; 0xEE = no data.
  // Extract battery voltage from block 3, offset 71 (SIAC only).
  // The raw byte encodes voltage as: V = 1.9 + raw * 0.09
  let batteryVoltage: number | null = null;
  let metadata: SICardMetadata | null = null;
  if (allBlocks.length >= 4) {
    const b3 = allBlocks[3];
    const rawVolt = b3[71];
    if (rawVolt > 0 && rawVolt !== 0xee && rawVolt < 0xff) {
      batteryVoltage = 1.9 + rawVolt * 0.09;
      if (batteryVoltage > 5.0) batteryVoltage = null; // invalid
    }
    metadata = parseSI10Metadata(b3);
  }

  return {
    cardNumber: cn,
    cardType,
    checkTime,
    startTime,
    finishTime,
    clearTime,
    punches,
    punchCount,
    ownerData,
    batteryVoltage,
    metadata,
  };
}

// ─── Transmit record parsing (online controls) ─────────────

export interface SITransmitPunch {
  cardNumber: number;
  controlCode: number;
  time: number; // seconds since midnight
}

/**
 * Parse a transmit record (CMD 0xD3) from an online control.
 */
export function parseTransmitRecord(
  data: Uint8Array,
): SITransmitPunch | null {
  if (data.length < 8) return null;
  // Typical format: StationCode(2) + CardNumber(3) + TD(1) + TimeH(1) + TimeL(1)
  const controlCode = (data[0] << 8) | data[1];
  const cardNumber = (data[2] << 16) | (data[3] << 8) | data[4];
  const time = parsePunchTime(data, 6);
  if (cardNumber === 0 || time === null) return null;
  return { cardNumber, controlCode, time };
}

// ─── Utility ───────────────────────────────────────────────

/** Check if a command byte is a card detection event */
export function isDetectionCommand(cmd: number): boolean {
  return (
    cmd === CMD.SI5_DETECTED ||
    cmd === CMD.SI6_DETECTED ||
    cmd === CMD.SI8_DETECTED
  );
}

/** Check if a command byte is a readout response */
export function isReadoutResponse(cmd: number): boolean {
  return (
    cmd === CMD.SI5_READ || cmd === CMD.SI6_READ || cmd === CMD.SI8_READ
  );
}

/** Valid SI commands for frame detection in the buffer scanner */
export const VALID_COMMANDS = new Set([
  CMD.SI5_READ,
  CMD.SI6_READ,
  CMD.SI8_READ,
  CMD.SI5_DETECTED,
  CMD.SI6_DETECTED,
  CMD.CARD_REMOVED,
  CMD.SI8_DETECTED,
  CMD.TRANSMIT_RECORD,
  CMD.SRR_PUNCH,
  CMD.SET_MS,
  CMD.GET_TIME,
  CMD.GET_SYSTEM_VALUE,
  CMD.SET_SYSTEM_VALUE,
  CMD.SET_TIME,
  CMD.ERASE_BACKUP,
  CMD.GET_BACKUP,
  CMD.OFF,
  CMD.BEEP,
]);

// ─── Station Configuration ────────────────────────────────

/** SYS_VAL memory offsets for station configuration */
export const SYSVAL = {
  SERIAL_NO: 0x00, // 4 bytes — station serial number
  SRR_CFG: 0x04, // 1 byte — bit0: SRR enabled
  FIRMWARE: 0x05, // 3 bytes — ASCII firmware version
  BUILD_DATE: 0x08, // 3 bytes — YYMMDD
  MODEL_ID: 0x0b, // 2 bytes — hardware model
  MEM_SIZE: 0x0d, // 1 byte — backup memory size in KB
  BAT_DATE: 0x15, // 3 bytes — battery installation date YYMMDD
  BAT_CAP: 0x19, // 2 bytes — initial battery capacity in mAh
  BACKUP_PTR_HI: 0x1c, // 2 bytes — backup pointer high
  BACKUP_PTR_LO: 0x21, // 2 bytes — backup pointer low
  BAT_VOLT: 0x50, // 2 bytes — V = raw * 5 / 65536
  PROGRAM: 0x70, // 1 byte — competition(0) or training(1)
  MODE: 0x71, // 1 byte — operating mode
  STATION_CODE: 0x72, // 1 byte — station code lower 8 bits
  FEEDBACK: 0x73, // 1 byte — bits 6-7: station code high, bit0: optical, bit1: acoustic, bit2: flash
  PROTO: 0x74, // 1 byte — bit0: extended, bit1: autosend, bit2: handshake, bit3: legacy, bit4: sprint4ms, bit5: card6_192
  AUTO_OFF: 0x7e, // 2 bytes (big-endian) — auto power-off time in minutes
} as const;

/** Station operating modes */
export const STATION_MODE = {
  SIAC_SPECIAL: 0x01,
  CONTROL: 0x02,
  START: 0x03,
  FINISH: 0x04,
  READOUT: 0x05,
  CLEAR_OLD: 0x06,
  CLEAR: 0x07,
  CHECK: 0x0a,
  PRINTOUT: 0x0b,
  START_TRIG: 0x0c,
  FINISH_TRIG: 0x0d,
  BC_CONTROL: 0x12,
  BC_START: 0x13,
  BC_FINISH: 0x14,
  BC_READOUT: 0x15,
} as const;

/** Direct/Remote (master/slave) mode constants */
export const MS_MODE = {
  DIRECT: 0x4d, // 'M' — master/direct
  REMOTE: 0x53, // 'S' — slave/remote
} as const;

/** Parsed station configuration from GET_SYSTEM_VALUE response */
export interface StationInfo {
  serialNo: number;
  stationCode: number; // 1–1023
  mode: number;
  srrEnabled: boolean;
  batteryVoltage: number; // volts
  batteryCapMah: number; // initial battery capacity in mAh
  firmwareVersion: string;
  memSizeKB: number;
  backupPointer: number; // raw backup memory write pointer (address)
  backupCount: number; // approximate number of backup records
}

/** A punch record from station backup memory (extended protocol BUX format) */
export interface BackupRecord {
  cardNo: number;
  /** Full punch datetime as ISO string (from backup record's date + time fields) */
  punchDatetime: string;
  /** Seconds since midnight (for MeOS oPunch compatibility, deciseconds = this * 10) */
  punchTimeSecs: number;
  /** Sub-second fraction (0-255, divide by 256 for seconds) */
  subSecond: number;
}

// ─── Station command builders ─────────────────────────────

/** Build SET_SYSTEM_VALUE command: write bytes starting at offset */
export function buildSetSysVal(
  offset: number,
  ...values: number[]
): Uint8Array {
  return buildCommand(CMD.SET_SYSTEM_VALUE, [offset, ...values]);
}

/** Build command to set station to direct (master) mode */
export function buildSetDirectMode(): Uint8Array {
  return buildCommand(CMD.SET_MS, [MS_MODE.DIRECT]);
}

/** Build command to set station to remote (slave/indirect) mode —
 *  commands are forwarded to the coupled field control via the coupling stick */
export function buildSetRemoteMode(): Uint8Array {
  return buildCommand(CMD.SET_MS, [MS_MODE.REMOTE]);
}

/**
 * Build command to read full SYS_VAL (128 bytes from offset 0).
 * @param remote — skip wakeup byte (required when BSM8 is in remote mode)
 */
export function buildGetSysVal(remote = false): Uint8Array {
  return buildCommand(CMD.GET_SYSTEM_VALUE, [0x00, 0x80], remote);
}

/**
 * Build SET_SYSTEM_VALUE command for remote mode (no wakeup byte).
 */
export function buildSetSysValRemote(
  offset: number,
  ...values: number[]
): Uint8Array {
  return buildCommand(CMD.SET_SYSTEM_VALUE, [offset, ...values], true);
}

/**
 * Build SET_TIME command from a Date.
 * @param remote — skip wakeup byte for remote mode
 */
export function buildSetTime(date: Date, remote = false): Uint8Array {
  const yy = date.getFullYear() % 100;
  const mm = date.getMonth() + 1;
  const dd = date.getDate();
  const hours = date.getHours();
  const mins = date.getMinutes();
  const secs = date.getSeconds();

  // dayAMPM: bits 3-1 = ISO weekday (Mon=1..Sun=7), bit 0 = PM flag
  const isoWeekday = date.getDay() === 0 ? 7 : date.getDay(); // JS: 0=Sun→7
  const pm = hours >= 12 ? 1 : 0;
  const dayAMPM = (isoWeekday << 1) | pm;

  // Seconds in 12h window
  const totalSeconds = (hours % 12) * 3600 + mins * 60 + secs;
  const secHi = (totalSeconds >> 8) & 0xff;
  const secLo = totalSeconds & 0xff;

  // Sub-second fraction: 1/256s units
  const frac = Math.round((date.getMilliseconds() / 1000) * 256) & 0xff;

  return buildCommand(CMD.SET_TIME, [yy, mm, dd, dayAMPM, secHi, secLo, frac], remote);
}

/**
 * Build ERASE_BACKUP command.
 * @param remote — skip wakeup byte for remote mode
 */
export function buildEraseBackup(remote = false): Uint8Array {
  return buildCommand(CMD.ERASE_BACKUP, [], remote);
}

/**
 * Build GET_BACKUP command for a specific page.
 * @param remote — skip wakeup byte for remote mode
 */
/**
 * Build GET_BACKUP command to read station backup memory.
 * Parameters: 3-byte address (ADR2, ADR1, ADR0) + 1-byte count (max 0x80).
 * Backup data starts at address 0x000100. End address comes from SYS_VAL
 * backup pointer fields (O_BACKUP_PTR_HI at 0x1C + O_BACKUP_PTR_LO at 0x21).
 */
export function buildGetBackup(
  adr2: number, adr1: number, adr0: number, count = 0x80, remote = false,
): Uint8Array {
  return buildCommand(CMD.GET_BACKUP, [adr2, adr1, adr0, count], remote);
}

/**
 * Build OFF command — power off station.
 * @param remote — skip wakeup byte for remote mode
 */
export function buildOff(remote = false): Uint8Array {
  return buildCommand(CMD.OFF, [], remote);
}

/**
 * Build BEEP command.
 * @param remote — skip wakeup byte for remote mode
 */
export function buildBeep(count: number = 1, remote = false): Uint8Array {
  return buildCommand(CMD.BEEP, [count], remote);
}

/** Encode a station code (1–1023) into STATION_CODE + FEEDBACK bytes */
export function encodeStationCode(
  code: number,
  currentFeedback: number = 0x37,
): { codeByte: number; feedbackByte: number } {
  const codeByte = code & 0xff;
  const codeHigh = (code >> 2) & 0xc0; // bits 8-9 of code → bits 6-7 of feedback
  const feedbackByte = (currentFeedback & 0x3f) | codeHigh;
  return { codeByte, feedbackByte };
}

/** Decode station code from STATION_CODE + FEEDBACK bytes */
export function decodeStationCode(
  codeByte: number,
  feedbackByte: number,
): number {
  return codeByte | ((feedbackByte & 0xc0) << 2);
}

// ─── Station response parsers ─────────────────────────────

/**
 * Parse a GET_SYSTEM_VALUE response into station configuration.
 *
 * Response format (verified via dump-sysval.py against Config+):
 *   [0x00] [station_id] [echoed_offset] [SYS_VAL data...]
 * 3-byte header + 128 bytes SYS_VAL = 131 bytes total for a full read.
 *
 * Confirmed field mappings (BSF8-SRR, firmware 657):
 *   0x00-0x03: Serial number (big-endian uint32)
 *   0x04:      SRR config (bit 0 = SRR enabled; other bits are factory config, don't overwrite)
 *   0x05-0x07: Firmware version as 3 ASCII chars (e.g. "657")
 *   0x08-0x0a: Production date YY MM DD
 *   0x50-0x51: Battery voltage — V = raw * 5 / 65536 (verified: 0xAFC0 → 3.43V ≈ Config+ 3.42V)
 *   0x70:      PROGRAM config bank — ASCII '0' (competition) or '1' (training)
 *   0x71:      Operating mode (see STATION_MODE)
 *   0x72:      Station code lower 8 bits
 *   0x73:      Feedback — bit0: optical, bit1: acoustic, bit2: flash, bits 6-7: code high
 *   0x74:      Protocol — bit0: extended, bit1: autosend, bit2: handshake, bit3: legacy, bit4: sprint4ms
 *   0x7e-0x7f: Auto power-off in minutes (big-endian uint16)
 */
export function parseStationInfo(data: Uint8Array): StationInfo | null {
  // 3-byte header: [0x00, station_id, echoed_offset]
  const P = 3;
  if (data.length < P + 0x75) return null;

  const serialNo =
    (data[P + SYSVAL.SERIAL_NO] << 24) |
    (data[P + SYSVAL.SERIAL_NO + 1] << 16) |
    (data[P + SYSVAL.SERIAL_NO + 2] << 8) |
    data[P + SYSVAL.SERIAL_NO + 3];

  const srrEnabled = (data[P + SYSVAL.SRR_CFG] & 0x01) !== 0;

  const fw0 = data[P + SYSVAL.FIRMWARE];
  const fw1 = data[P + SYSVAL.FIRMWARE + 1];
  const fw2 = data[P + SYSVAL.FIRMWARE + 2];
  const firmwareVersion = String.fromCharCode(fw0, fw1, fw2);

  const memSizeKB = data[P + SYSVAL.MEM_SIZE];

  // Battery voltage: 2 bytes at offset 0x50, V = raw * 5 / 65536
  const batRaw = (data[P + SYSVAL.BAT_VOLT] << 8) | data[P + SYSVAL.BAT_VOLT + 1];
  const batteryVoltage = (batRaw * 5) / 65536;

  // Battery capacity: 2 bytes at offset 0x19, initial capacity in mAh
  const batteryCapMah = (data[P + SYSVAL.BAT_CAP] << 8) | data[P + SYSVAL.BAT_CAP + 1];

  // Backup pointer (approximate record count)
  const bpHi =
    (data[P + SYSVAL.BACKUP_PTR_HI] << 8) | data[P + SYSVAL.BACKUP_PTR_HI + 1];
  const bpLo =
    (data[P + SYSVAL.BACKUP_PTR_LO] << 8) | data[P + SYSVAL.BACKUP_PTR_LO + 1];
  const backupPointer = (bpHi << 16) | bpLo;
  // Data starts at 0x100, each record is 8 bytes
  const backupCount = backupPointer > 0x100 ? Math.floor((backupPointer - 0x100) / 8) : 0;

  const mode = data[P + SYSVAL.MODE];
  const stationCode = decodeStationCode(
    data[P + SYSVAL.STATION_CODE],
    data[P + SYSVAL.FEEDBACK],
  );

  return {
    serialNo,
    stationCode,
    mode,
    srrEnabled,
    batteryVoltage,
    batteryCapMah,
    firmwareVersion,
    memSizeKB,
    backupPointer,
    backupCount,
  };
}

/**
 * Parse a GET_TIME response and compute drift from the computer clock.
 * Response format: StationNumber(2) + YY + MM + DD + dayAMPM + secHi + secLo + fraction(1/256s)
 * Returns drift in milliseconds (positive = station ahead, negative = station behind).
 */
export function parseTimeDrift(
  data: Uint8Array,
  sendTimeMs: number,
  recvTimeMs: number,
): number | null {
  // 2-byte station prefix + 7 bytes of time data
  if (data.length < 9) return null;

  const yy = data[2];
  const mm = data[3];
  const dd = data[4];
  const dayAMPM = data[5];
  const secHi = data[6];
  const secLo = data[7];
  const frac = data[8]; // 1/256 second

  const pm = dayAMPM & 0x01;
  const totalSeconds = (secHi << 8) | secLo;
  const hours = Math.floor(totalSeconds / 3600) + (pm ? 12 : 0);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const ms = Math.round((frac / 256) * 1000);

  const stationDate = new Date(2000 + yy, mm - 1, dd, hours, mins, secs, ms);
  // Best estimate of "when the station sampled the time" is midpoint of send/recv
  const computerTimeMs = (sendTimeMs + recvTimeMs) / 2;

  return stationDate.getTime() - computerTimeMs;
}

/**
 * Parse a GET_BACKUP response into punch records.
 *
 * Response format (verified via dump-sysval.py):
 *   4-byte header: [0x00, station_code, addr_hi, addr_lo]
 *   followed by 8-byte records until empty (all 0x00 or 0xFF).
 *
 * Record format (8 bytes per punch):
 *   SN3(1) SN2(1) SN1(1) SN0(1) TD(1) TH(1) TL(1) TMS(1)
 *   - SN3 high nibble may contain control number extension
 *   - TD bit 0 = PM flag (add 12h if set), bits 1-3 = day of week
 *   - TH:TL = seconds since midnight (or since noon if PM)
 *   - TMS = sub-second (1/256 sec, currently ignored)
 */
/**
 * Parse a GET_BACKUP response page into punch records.
 *
 * Response format: [cmd_echo, station_id, addr2, addr1, addr0, ...data]
 * The first byte after framing is the echoed address prefix (5 bytes total header).
 * After the header, records are 8 bytes each (extended protocol BUX format):
 *
 *   Byte 0-2: Card number (3 bytes, MSB first) — decode with SI card numbering
 *   Byte 3:   Year/Month high (bits 7..2 = year since 2000, bits 1..0 = month high)
 *   Byte 4:   Month low/Day/AM-PM (bits 7..6 = month low, bits 5..1 = day, bit 0 = AM/PM)
 *   Byte 5-6: Seconds since midnight (AM) or midday (PM), 2 bytes big-endian
 *   Byte 7:   Sub-second fraction (÷256 for seconds)
 */
export function parseBackupPage(data: Uint8Array): BackupRecord[] {
  const records: BackupRecord[] = [];
  const RECORD_SIZE = 8;

  // Response header: the frame parser gives us the payload after cmd+len.
  // For GET_BACKUP that's: [0x00, station_id, adr2, adr1, adr0, ...records]
  // But sireader2.py uses BUX_FIRST=2 (skip 2 bytes) + 1 = offset 3 into payload.
  // Our frame parser strips cmd byte, so data starts at param data.
  // Header is 5 bytes: [0x00, station_code, adr2, adr1, adr0]
  const HEADER = 5;
  const start = data.length > HEADER ? HEADER : 0;

  for (let offset = start; offset + RECORD_SIZE <= data.length; offset += RECORD_SIZE) {
    const rec = data.slice(offset, offset + RECORD_SIZE);

    // Skip empty/erased records
    const ffCount = rec.filter((b) => b === 0xff).length;
    if (ffCount >= 6) break;
    if (rec.every((b) => b === 0x00)) break;

    const recHex = Array.from(rec).map((b) => b.toString(16).padStart(2, "0")).join(" ");

    // Card number: 3 bytes MSB first (same encoding as SI card data)
    const cardNo = (rec[0] << 16) | (rec[1] << 8) | rec[2];
    if (cardNo === 0 || cardNo === 0xffffff) break;

    // Byte 3: year/month high — bits 7..2 = year since 2000, bits 1..0 = month upper
    const ym = rec[3];
    const year = 2000 + (ym >> 2);
    const monthHi = ym & 0x03;

    // Byte 4: month low/day/AM-PM — bits 7..6 = month lower, bits 5..1 = day, bit 0 = AM/PM
    const mdap = rec[4];
    const month = (monthHi << 2) | (mdap >> 6);
    const day = (mdap >> 1) & 0x1f;
    const pm = mdap & 0x01;

    // Bytes 5-6: seconds since midnight (AM=0) or midday (PM=1)
    const secsRaw = (rec[5] << 8) | rec[6];
    const punchTimeSecs = secsRaw + (pm ? 43200 : 0);
    const subSecond = rec[7];

    // Build full datetime
    const hours = Math.floor(punchTimeSecs / 3600);
    const mins = Math.floor((punchTimeSecs % 3600) / 60);
    const secs = punchTimeSecs % 60;
    const ms = Math.round((subSecond / 256) * 1000);
    const dt = new Date(year, month - 1, day, hours, mins, secs, ms);
    const punchDatetime = dt.toISOString();

    console.log(
      `[SI] Backup record @${offset}: ${recHex} → card=${cardNo} ` +
      `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ` +
      `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${subSecond}`,
    );

    records.push({ cardNo, punchDatetime, punchTimeSecs, subSecond });
  }

  return records;
}

/** Check if a mode byte represents a control mode */
export function isControlMode(mode: number): boolean {
  return (
    mode === STATION_MODE.CONTROL ||
    mode === STATION_MODE.BC_CONTROL
  );
}

/** Get a human-readable label for a station mode */
export function stationModeLabel(mode: number): string {
  switch (mode) {
    case STATION_MODE.SIAC_SPECIAL: return "SIAC Special";
    case STATION_MODE.CONTROL: return "Control";
    case STATION_MODE.START: return "Start";
    case STATION_MODE.FINISH: return "Finish";
    case STATION_MODE.READOUT: return "Readout";
    case STATION_MODE.CLEAR_OLD: return "Clear (old)";
    case STATION_MODE.CLEAR: return "Clear";
    case STATION_MODE.CHECK: return "Check";
    case STATION_MODE.PRINTOUT: return "Printout";
    case STATION_MODE.START_TRIG: return "Start (trigger)";
    case STATION_MODE.FINISH_TRIG: return "Finish (trigger)";
    case STATION_MODE.BC_CONTROL: return "Beacon Control";
    case STATION_MODE.BC_START: return "Beacon Start";
    case STATION_MODE.BC_FINISH: return "Beacon Finish";
    case STATION_MODE.BC_READOUT: return "Beacon Readout";
    default: return `Unknown (0x${mode.toString(16)})`;
  }
}
