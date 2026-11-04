/**
 * SPORTident Reader BT — GATT message protocol (pure, no Web Bluetooth).
 *
 * Source: https://docs.sportident.com/developers/reader-bt
 * Oxygen's notes: docs/si-protocol/reader-bt.md
 *
 * Every message is `{u16 message_id, u16 payload_length, payload}`,
 * little-endian, no CRC. Messages larger than the ATT MTU arrive as a
 * series of 0xA101 wrapper notifications that SegmentReassembler joins.
 */

import {
  PERSONAL_FIELDS,
  decodeCp850,
  getCardType,
  type SICardMetadata,
  type SICardOwnerData,
  type SICardReadout,
  type SICardType,
  type SIPunch,
} from "../si-protocol";

// ─── UUIDs and message ids ─────────────────────────────────

const rbt = (short: string) => `bd51${short}-6aec-4628-a146-f3e95bc49e62`;

export const RBT_UUID = {
  /** Primary (advertised) service */
  settingsService: rbt("0001"),
  /** Notify + write: device info / settings requests and responses */
  readSettings: rbt("0002"),
  /** Write: settings, autosend, sleep */
  writeSettings: rbt("0003"),
  cardService: rbt("0011"),
  /** Notify: CardStateChange */
  cardState: rbt("0012"),
  /** Notify + write: readout requests/responses, feedback */
  cardData: rbt("0013"),
  sessionsService: rbt("0031"),
  /** Notify + write: session table and session data */
  sessions: rbt("0032"),
  /** Bluetooth SIG Battery Service / Battery Level (uint8 percent) */
  batteryService: "0000180f-0000-1000-8000-00805f9b34fb",
  batteryLevel: "00002a19-0000-1000-8000-00805f9b34fb",
} as const;

export const RBT_MSG = {
  SET_TO_SLEEP: 0x0101,
  READ_ALL_SETTINGS: 0x010c,
  WRITE_ALL_SETTINGS: 0x010d,
  READ_DEVICE_INFO: 0x010e,
  SET_AUTOSEND: 0x010f,
  READ_AUTOSEND: 0x0110,
  CARD_STATE_CHANGE: 0x1101,
  CARD_DATA_MINIMAL: 0x1102,
  CARD_DATA_COMPLETE: 0x1103,
  FEEDBACK: 0x1110,
  SESSIONS_LIST_REQUEST: 0x3101,
  SESSION_DATA_REQUEST: 0x3102,
  SESSIONS_LIST_RESPONSE: 0x3103,
  SESSION_DATA_RESPONSE: 0x3104,
  SEGMENT: 0xa101,
} as const;

/** Device type reported in ReadDeviceInfo */
export const RBT_DEVICE_TYPE = 0x00a7;

export const RBT_OPERATING_MODE = {
  READOUT: 0x05,
  PRINTOUT: 0x0b,
  STANDALONE: 0x0c,
} as const;

export const RBT_PUNCH_TYPE = {
  UNDEFINED: 0,
  CLEAR: 1,
  CHECK: 2,
  START: 3,
  START_RESERVE: 4,
  FINISH: 5,
  FINISH_RESERVE: 6,
  CONTROL: 7,
} as const;

/** card_family byte → card type. SI10/SI11/ComCard codes are undocumented. */
export const RBT_CARD_FAMILY: Record<number, SICardType> = {
  1: "SI9",
  2: "SI8",
  4: "pCard",
  15: "SIAC",
};

const SIAC_FAMILY = 15;
const SIAC_PRODUCTION_SIZE = 13;
const PUNCH_SIZE = 8;
const SESSION_ENTRY_SIZE = 20;
const DAY_MS = 86_400_000;

export class RbtProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RbtProtocolError";
  }
}

// ─── Framing ───────────────────────────────────────────────

export interface RbtMessage {
  id: number;
  payload: Uint8Array;
  /** The complete message, header included (kept for backup import) */
  raw: Uint8Array;
}

function toBytes(data: Uint8Array | DataView | ArrayBuffer): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof DataView) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

export function encodeMessage(id: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  const v = view(out);
  v.setUint16(0, id, true);
  v.setUint16(2, payload.length, true);
  out.set(payload, 4);
  return out;
}

/** Read one message from the start of `data`; trailing bytes are ignored. */
export function decodeMessage(data: Uint8Array | DataView | ArrayBuffer): RbtMessage {
  const b = toBytes(data);
  if (b.length < 4) throw new RbtProtocolError(`Message shorter than header (${b.length} bytes)`);
  const v = view(b);
  const id = v.getUint16(0, true);
  const len = v.getUint16(2, true);
  if (b.length < 4 + len) {
    throw new RbtProtocolError(
      `Message 0x${id.toString(16)} truncated: payload_length ${len}, got ${b.length - 4}`,
    );
  }
  const raw = b.subarray(0, 4 + len);
  return { id, payload: raw.subarray(4), raw };
}

/** Split a buffer of back-to-back messages (session data). Must consume it exactly. */
export function splitMessages(data: Uint8Array | DataView | ArrayBuffer): RbtMessage[] {
  const b = toBytes(data);
  const out: RbtMessage[] = [];
  let off = 0;
  while (off < b.length) {
    const msg = decodeMessage(b.subarray(off));
    out.push(msg);
    off += msg.raw.length;
  }
  return out;
}

// ─── Segmentation (0xA101) ─────────────────────────────────

const SEGMENT_FLAG = { CONTINUATION: 0x00, FIRST: 0x01, LAST: 0x02 } as const;

/**
 * The docs name the wrapper 0xA101, but their worked example starts each
 * wrapper with the bytes `A1 01`, which is 0x01A1 little-endian. Accept both
 * until hardware settles it (docs/si-protocol/reader-bt.md, open questions);
 * no other message uses either id.
 */
export function isSegmentId(id: number): boolean {
  return id === RBT_MSG.SEGMENT || id === 0x01a1;
}

/**
 * Joins 0xA101 wrapper notifications into the original message. Keep one per
 * notifying characteristic. Non-wrapper notifications pass straight through.
 * Protocol violations reset the buffer and throw RbtProtocolError.
 */
export class SegmentReassembler {
  private buffer: number[] | null = null;
  private total = 0;

  push(notification: Uint8Array | DataView | ArrayBuffer): RbtMessage | null {
    const msg = decodeMessage(notification);
    if (!isSegmentId(msg.id)) return msg;

    const p = msg.payload;
    if (p.length < 1) return this.fail("Segment without packet flag");
    const flag = p[0];

    if (flag === SEGMENT_FLAG.FIRST) {
      if (p.length < 5) return this.fail("First segment without total length");
      this.total = view(p).getUint32(1, true);
      this.buffer = Array.from(p.subarray(5));
    } else if (flag === SEGMENT_FLAG.CONTINUATION || flag === SEGMENT_FLAG.LAST) {
      if (!this.buffer) return this.fail("Segment without a preceding first segment");
      for (const byte of p.subarray(1)) this.buffer.push(byte);
    } else {
      return this.fail(`Unknown segment flag 0x${flag.toString(16)}`);
    }

    if (this.buffer.length > this.total) {
      return this.fail(`Segments overflow total length ${this.total}`);
    }
    if (flag !== SEGMENT_FLAG.LAST) return null;
    if (this.buffer.length !== this.total) {
      return this.fail(`Reassembled length ${this.buffer.length} != total length ${this.total}`);
    }
    const whole = new Uint8Array(this.buffer);
    this.reset();
    return decodeMessage(whole);
  }

  reset(): void {
    this.buffer = null;
    this.total = 0;
  }

  private fail(message: string): never {
    this.reset();
    throw new RbtProtocolError(message);
  }
}

// ─── Card state / card data ────────────────────────────────

export interface RbtCardState {
  cardNumber: number;
  inserted: boolean;
  codeNumber: number;
}

export function decodeCardStateChange(payload: Uint8Array): RbtCardState {
  need(payload, 7, "CardStateChange");
  const v = view(payload);
  return {
    cardNumber: v.getUint32(0, true),
    inserted: payload[4] === 1,
    codeNumber: v.getUint16(5, true),
  };
}

export interface RbtPunch {
  controlInfo: number;
  /** RBT_PUNCH_TYPE */
  type: number;
  code: number;
  /** Milliseconds since Sunday 00:00:00 */
  timeMs: number;
  /** SIAC beacon: control_info bit 5 (punching mode, else timing mode) */
  punchingMode: boolean;
  /** SIAC radio mode, control_info bits 6–7: 0 no, 1 last, 2 all, 3 all new */
  radioMode: number;
}

export interface RbtSiacProduction {
  hardwareVersion: string;
  softwareVersion: string;
  signalCount: number;
  clearCount: number;
  batteryMv: number;
  /** YYYY-MM-DD, null if the stored month/day is out of range */
  batteryDate: string | null;
  /** YYYY-MM (the block carries no day) */
  productionDate: string | null;
}

export interface RbtCardData {
  cardNumber: number;
  cardFamily: number;
  punches: RbtPunch[];
  /** SIAC production block (complete readout, SIAC 8000000–8999999 only) */
  siac?: RbtSiacProduction;
  /** Owner data (complete readout only); null if the block was empty */
  owner?: SICardOwnerData | null;
  /** Owner data charset byte: 1 = ISO-8859-1, 17 = GB2312 */
  ownerCharset?: number;
  /** true for 0x1103, false for 0x1102 */
  complete: boolean;
}

/** Decode a 0x1102 (minimal) or 0x1103 (complete) card readout message (or its raw bytes). */
export function decodeCardData(input: RbtMessage | Uint8Array): RbtCardData {
  const msg = input instanceof Uint8Array ? decodeMessage(input) : input;
  if (msg.id !== RBT_MSG.CARD_DATA_MINIMAL && msg.id !== RBT_MSG.CARD_DATA_COMPLETE) {
    throw new RbtProtocolError(`Not a card readout message: 0x${msg.id.toString(16)}`);
  }
  const p = msg.payload;
  need(p, 7, "Card readout");
  const v = view(p);
  const cardNumber = v.getUint32(0, true);
  const cardFamily = p[4];
  const punchCount = v.getUint16(5, true);
  need(p, 7 + punchCount * PUNCH_SIZE, "Card readout punches");

  const punches: RbtPunch[] = [];
  for (let i = 0; i < punchCount; i++) {
    const off = 7 + i * PUNCH_SIZE;
    const controlInfo = p[off];
    punches.push({
      controlInfo,
      type: p[off + 1],
      code: v.getUint16(off + 2, true),
      timeMs: v.getUint32(off + 4, true),
      punchingMode: (controlInfo & 0x20) !== 0,
      radioMode: (controlInfo & 0xc0) >> 6,
    });
  }

  const complete = msg.id === RBT_MSG.CARD_DATA_COMPLETE;
  const data: RbtCardData = { cardNumber, cardFamily, punches, complete };
  if (!complete) return data;

  let off = 7 + punchCount * PUNCH_SIZE;
  if (cardFamily === SIAC_FAMILY && cardNumber >= 8_000_000 && cardNumber < 9_000_000) {
    need(p, off + SIAC_PRODUCTION_SIZE, "SIAC production data");
    data.siac = decodeSiacProduction(p.subarray(off, off + SIAC_PRODUCTION_SIZE));
    off += SIAC_PRODUCTION_SIZE;
  }
  if (off < p.length) {
    data.ownerCharset = p[off];
    data.owner = decodeOwner(p[off], p.subarray(off + 1));
  }
  return data;
}

function decodeSiacProduction(b: Uint8Array): RbtSiacProduction {
  const v = view(b);
  const version = (raw: number) => `${Math.floor(raw / 10)}.${raw % 10}`;
  const [by, bm, bd, py, pm] = [b[8], b[9], b[10], b[11], b[12]];
  return {
    hardwareVersion: version(b[0]),
    softwareVersion: version(b[1]),
    signalCount: v.getUint16(2, true),
    clearCount: v.getUint16(4, true),
    batteryMv: v.getUint16(6, true),
    batteryDate: isoDate(2000 + by, bm, bd),
    productionDate: pm >= 1 && pm <= 12 ? `${2000 + py}-${pad2(pm)}` : null,
  };
}

/**
 * Charset 1 is documented as ISO-8859-1, but the reader passes the card's
 * bytes through unchanged, and cards store owner data in CP850 (the USB path
 * decodes the same area that way). Hardware confirmed it: "ä" arrives as
 * 0x84, a C1 control code in Latin-1. So charset 1 is decoded as CP850.
 */
function decodeText(charset: number, bytes: Uint8Array): string {
  if (charset !== 17) return decodeCp850(bytes);
  try {
    return new TextDecoder("gb2312").decode(bytes);
  } catch {
    // Runtime without the GB2312 decoder: fall back to Latin-1 rather than losing the readout.
    return new TextDecoder("iso-8859-1").decode(bytes);
  }
}

function decodeOwner(charset: number, bytes: Uint8Array): SICardOwnerData | null {
  const nul = bytes.indexOf(0);
  const text = decodeText(charset, nul >= 0 ? bytes.subarray(0, nul) : bytes);
  const segments = text.split(";");
  const result: Record<string, string> = {};
  for (let i = 0; i < PERSONAL_FIELDS.length && i < segments.length; i++) {
    const val = segments[i].trim();
    if (val) result[PERSONAL_FIELDS[i]] = val;
  }
  return Object.keys(result).length > 0 ? (result as SICardOwnerData) : null;
}

// ─── Settings service ──────────────────────────────────────

export interface RbtDeviceInfo {
  serialNumber: number;
  deviceType: number;
  hardwareVersion: string;
  productionDate: string | null;
  batteryDate: string | null;
  softwareVersion: string;
}

/**
 * The x.y.z part of the software string. Firmware 2.2.0 reports
 * "sireader@2.2.0+71f89ff.20261008113738"; anything without a version is
 * returned as is.
 */
export function firmwareVersion(software: string): string {
  return /(\d+\.\d+\.\d+)/.exec(software)?.[1] ?? software;
}

export function decodeDeviceInfo(payload: Uint8Array): RbtDeviceInfo {
  need(payload, 16, "ReadDeviceInfo");
  const v = view(payload);
  const sw = payload.subarray(16);
  const nul = sw.indexOf(0);
  return {
    serialNumber: v.getUint32(0, true),
    deviceType: v.getUint16(4, true),
    hardwareVersion: `${payload[6]}.${payload[7]}`,
    productionDate: isoDate(v.getUint16(8, true), payload[10], payload[11]),
    batteryDate: isoDate(v.getUint16(12, true), payload[14], payload[15]),
    softwareVersion: new TextDecoder("ascii").decode(nul >= 0 ? sw.subarray(0, nul) : sw),
  };
}

export interface RbtSettings {
  codeNumber: number;
  /** RBT_OPERATING_MODE; a 0/1 auto_read flag on firmware < 2.0.0 */
  operatingMode: number;
  /** Whole payload, for a read-modify-write through WriteAllSettings */
  raw: Uint8Array;
}

export function decodeAllSettings(payload: Uint8Array): RbtSettings {
  need(payload, 3, "ReadAllSettings");
  return {
    codeNumber: view(payload).getUint16(0, true),
    operatingMode: payload[2],
    raw: payload.slice(),
  };
}

export function decodeAutosend(payload: Uint8Array): boolean {
  need(payload, 1, "ReadAutosend");
  return payload[0] === 1;
}

export type RbtOperatingModeLabel = "readout" | "printout" | "standalone" | "other";

export function operatingModeLabel(mode: number): RbtOperatingModeLabel {
  switch (mode) {
    case RBT_OPERATING_MODE.READOUT:
      return "readout";
    case RBT_OPERATING_MODE.PRINTOUT:
      return "printout";
    case RBT_OPERATING_MODE.STANDALONE:
      return "standalone";
    default:
      return "other";
  }
}

// ─── Sessions service ──────────────────────────────────────

export interface RbtSessionEntry {
  sessionNumber: number;
  /** Unix seconds, 0 = unknown (current readers have no RTC) */
  startTime: number;
  /** Unix seconds, or a duration in seconds when startTime is 0 */
  endTime: number;
  readoutCount: number;
}

export interface RbtSessionsPage {
  page: number;
  totalPages: number;
  entries: RbtSessionEntry[];
}

export function decodeSessionsList(payload: Uint8Array): RbtSessionsPage {
  need(payload, 3, "ReadAvailableSessionsResponse");
  const count = payload[2];
  need(payload, 3 + count * SESSION_ENTRY_SIZE, "Session entries");
  const v = view(payload);
  const entries: RbtSessionEntry[] = [];
  for (let i = 0; i < count; i++) {
    const off = 3 + i * SESSION_ENTRY_SIZE;
    entries.push({
      sessionNumber: v.getUint16(off, true),
      startTime: Number(v.getBigUint64(off + 2, true)),
      endTime: Number(v.getBigUint64(off + 10, true)),
      readoutCount: v.getUint16(off + 18, true),
    });
  }
  return { page: payload[0], totalPages: payload[1], entries };
}

export interface RbtSessionData {
  sessionNumber: number;
  /** Embedded 0x1102/0x1103 messages, each with its own header */
  readouts: RbtMessage[];
}

export function decodeSessionData(payload: Uint8Array): RbtSessionData {
  need(payload, 8, "ReadSessionDataResponse");
  const v = view(payload);
  const sessionNumber = v.getUint16(0, true);
  const count = v.getUint16(2, true);
  const length = v.getUint32(4, true);
  need(payload, 8 + length, "Session data");
  const readouts = splitMessages(payload.subarray(8, 8 + length));
  if (readouts.length !== count) {
    throw new RbtProtocolError(
      `Session ${sessionNumber}: header says ${count} readouts, found ${readouts.length}`,
    );
  }
  return { sessionNumber, readouts };
}

// ─── Request encoders ──────────────────────────────────────

/** 0x1103 (complete, default) or 0x1102 (minimal) readout request, written to card data */
export function encodeCardDataRequest(complete = true): Uint8Array {
  return encodeMessage(complete ? RBT_MSG.CARD_DATA_COMPLETE : RBT_MSG.CARD_DATA_MINIMAL);
}

/** Feedback (two beeps for OK, four for error), written to card data */
export function encodeFeedback(ok: boolean): Uint8Array {
  return encodeMessage(RBT_MSG.FEEDBACK, new Uint8Array([ok ? 1 : 2]));
}

/** Per-connection AUTOSEND (firmware ≥ 2.0.0), written to write settings */
export function encodeSetAutosend(enabled: boolean): Uint8Array {
  return encodeMessage(RBT_MSG.SET_AUTOSEND, new Uint8Array([enabled ? 1 : 0]));
}

export function encodeSessionsListRequest(page: number): Uint8Array {
  return encodeMessage(RBT_MSG.SESSIONS_LIST_REQUEST, new Uint8Array([page & 0xff]));
}

export function encodeSessionDataRequest(sessionNumber: number): Uint8Array {
  const p = new Uint8Array(2);
  view(p).setUint16(0, sessionNumber, true);
  return encodeMessage(RBT_MSG.SESSION_DATA_REQUEST, p);
}

// ─── Mapping to SICardReadout ──────────────────────────────

/** Day index from ms-since-Sunday (0=Sun) → SI day of week (1=Mon..7=Sun) */
function siDayOfWeek(timeMs: number): number {
  const dayIdx = Math.floor(timeMs / DAY_MS) % 7;
  return dayIdx === 0 ? 7 : dayIdx;
}

/**
 * The millisecond part as 1/256 s, the unit SI stations use for sub-seconds.
 * Hardware delivers SIAC times in exact multiples of 1000/256 ms.
 */
function subSecond256(timeMs: number): number {
  return Math.min(255, Math.round(((timeMs % 1000) * 256) / 1000));
}

/** Integer seconds since midnight; the millisecond part is dropped */
function secondsOfDay(timeMs: number): number {
  return Math.floor((timeMs % DAY_MS) / 1000);
}

/**
 * Convert a Reader BT readout into the shape the USB path produces, so it
 * can go through DeviceManager.addRecentCard unchanged.
 */
export function toSICardReadout(d: RbtCardData): SICardReadout {
  const first = (type: number) => d.punches.find((p) => p.type === type);
  const clear = first(RBT_PUNCH_TYPE.CLEAR);
  const check = first(RBT_PUNCH_TYPE.CHECK);
  const start = first(RBT_PUNCH_TYPE.START) ?? first(RBT_PUNCH_TYPE.START_RESERVE);
  const finish = first(RBT_PUNCH_TYPE.FINISH) ?? first(RBT_PUNCH_TYPE.FINISH_RESERVE);

  const punches: SIPunch[] = d.punches
    .filter((p) => p.type === RBT_PUNCH_TYPE.CONTROL || p.type === RBT_PUNCH_TYPE.UNDEFINED)
    .map((p) => {
      const punch: SIPunch = { controlCode: p.code, time: secondsOfDay(p.timeMs) };
      const sub = subSecond256(p.timeMs);
      if (sub > 0) punch.subSecond = sub;
      return punch;
    });

  const byNumber = getCardType(d.cardNumber);
  const cardType = byNumber !== "Unknown" ? byNumber : (RBT_CARD_FAMILY[d.cardFamily] ?? "Unknown");

  let metadata: SICardMetadata | null = null;
  if (d.siac) {
    metadata = {
      hardwareVersion: d.siac.hardwareVersion,
      softwareVersion: d.siac.softwareVersion,
      clearCount: d.siac.clearCount,
    };
    if (d.siac.batteryDate) metadata.batteryDate = d.siac.batteryDate;
    if (d.siac.productionDate) metadata.productionDate = d.siac.productionDate;
  }

  return {
    cardNumber: d.cardNumber,
    cardType,
    clearTime: clear ? secondsOfDay(clear.timeMs) : null,
    checkTime: check ? secondsOfDay(check.timeMs) : null,
    startTime: start ? secondsOfDay(start.timeMs) : null,
    finishTime: finish ? secondsOfDay(finish.timeMs) : null,
    finishDayOfWeek: finish ? siDayOfWeek(finish.timeMs) : null,
    checkDayOfWeek: check ? siDayOfWeek(check.timeMs) : null,
    punches,
    punchCount: punches.length,
    ownerData: d.owner ?? null,
    batteryVoltage: d.siac ? d.siac.batteryMv / 1000 : null,
    metadata,
  };
}

// ─── Helpers ───────────────────────────────────────────────

function need(b: Uint8Array, n: number, what: string): void {
  if (b.length < n) throw new RbtProtocolError(`${what}: need ${n} bytes, got ${b.length}`);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}
