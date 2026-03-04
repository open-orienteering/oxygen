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
  GET_BACKUP: 0x81,
  SET_MS_MODE: 0x70,

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
 */
export function buildCommand(cmd: number, params: number[] = []): Uint8Array {
  const len = params.length;
  const frame = new Uint8Array(7 + len);
  frame[0] = WAKEUP;
  frame[1] = STX;
  frame[2] = cmd;
  frame[3] = len;
  for (let i = 0; i < len; i++) frame[4 + i] = params[i];

  // CRC over CMD + LEN + PARAMS
  const crcData = frame.slice(2, 4 + len);
  const crc = calculateCRC(crcData);
  frame[4 + len] = (crc >> 8) & 0xff;
  frame[5 + len] = crc & 0xff;
  frame[6 + len] = ETX;
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
  0xf0, // SET_MS response
  0xf7, // GET_TIME response
]);
