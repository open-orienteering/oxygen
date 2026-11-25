/**
 * WebSerial adapter for SportIdent readers.
 *
 * Wraps the Web Serial API with an EventTarget-based interface.
 * Handles connection, byte-level reading, frame extraction,
 * and automatic card readout when a card is detected.
 *
 * Ported from start-helper/js/serial.js.
 */

import {
  extractFrame,
  parseCardDetection,
  parseSI5CardData,
  parseSI8CardData,
  parseSI10CardData,
  parseTransmitRecord,
  buildReadCommand,
  isDetectionCommand,
  isReadoutResponse,
  isLargeCardType,
  CMD,
  ACK,
  SYSVAL,
  STATION_MODE,
  resolveProgrammingMode,
  supportsFullReadout,
  BLOCKS_TO_READ,
  buildCommand,
  buildSetSysVal,
  buildSetDirectMode,
  buildSetRemoteMode,
  buildGetSysVal,
  buildSetTime,
  buildEraseBackup,
  buildGetBackup,
  buildOff,
  buildBeep,
  encodeStationCode,
  parseStationInfo,
  parseTimeDrift,
  parseBackupPage,
  parseReadoutBackupBufferDetailed,
  isControlMode,
  isReadoutMode,
  stationModeLabel,
  type AutosendMode,
  type SICardDetection,
  type SICardReadout,
  type SITransmitPunch,
  type SICardType,
  type SIParsedFrame,
  type StationInfo,
  type BackupRecord,
  type ReadoutBackupRecord,
  type SkippedBackupSlot,
} from "./si-protocol";
import type {
  SIReader,
  SIReaderDeviceInfo,
  SIReaderMode,
  SIReaderStatus,
} from "./si-reader";

export type { SIReaderStatus } from "./si-reader";

/**
 * Result of `readBackupMemory()`. Discriminated by station operating mode:
 *  - `'control'` → flat list of punch records (control-mode BUX format)
 *  - `'readout'` → list of full card readouts recovered from a readout
 *    station's backup flash
 */
export type BackupResult =
  | {
      mode: "control";
      records: BackupRecord[];
      stationSerial: number;
      stationCode: number;
    }
  | {
      mode: "readout";
      records: ReadoutBackupRecord[];
      /** Non-empty slots that could not be decoded; the station must not be erased. */
      skippedSlots: SkippedBackupSlot[];
      stationSerial: number;
      stationCode: number;
    };

// ─── Debug logging ─────────────────────────────────────────
// Enable with: localStorage.setItem("oxygen-si-debug", "1")
const SI_DEBUG = (() => { try { return localStorage.getItem("oxygen-si-debug") === "1"; } catch { return false; } })();
function siLog(...args: unknown[]) { if (SI_DEBUG) console.log("[SI]", ...args); }
function siWarn(...args: unknown[]) { console.warn("[SI]", ...args); }

// ─── Events emitted by SIReaderConnection ──────────────────

export interface SICardDetectedEvent extends CustomEvent {
  detail: SICardDetection;
}
export interface SICardRemovedEvent extends CustomEvent {
  detail: Record<string, never>;
}
export interface SICardReadoutEvent extends CustomEvent {
  detail: SICardReadout;
}
export interface SITransmitPunchEvent extends CustomEvent {
  detail: SITransmitPunch;
}
export type SICardReadFailureReason = "timeout" | "removed" | "bad-block" | "parse";
export interface SICardReadFailure {
  cardNumber: number;
  cardType: SICardType;
  reason: SICardReadFailureReason;
  blocksReceived: number;
  blocksExpected: number;
}
export interface SICardReadFailedEvent extends CustomEvent {
  detail: SICardReadFailure;
}
export interface SIStatusEvent extends CustomEvent {
  detail: { status: SIReaderStatus };
}

// ─── Types ─────────────────────────────────────────────────

export interface SIReaderInfo {
  status: SIReaderStatus;
  portInfo?: SerialPortInfoLike;
}

// ─── WebSerial types ───────────────────────────────────────
// The WebSerial API is not part of the standard TS lib; these are the
// minimal structural types this module needs.

export interface SerialPortInfoLike {
  usbVendorId?: number;
  usbProductId?: number;
}

interface SerialOptionsLike {
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: string;
  flowControl?: string;
}

export interface SerialPortLike {
  open(options: SerialOptionsLike): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfoLike;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array>;
}

interface NavigatorSerialLike {
  requestPort(): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}

// ─── Serial config ─────────────────────────────────────────

const SERIAL_OPTIONS: SerialOptionsLike = {
  baudRate: 38400,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flowControl: "none",
};

/** Timeout waiting for a single block response */
const BLOCK_TIMEOUT_MS = 2000;

/** A readout block frame: station code (2) + block number (1) + 128 data bytes. */
const READOUT_BLOCK_FRAME_LEN = 131;
/** SI5 readout frame (0xB1): station code (2) + 128 data bytes, no block number. */
const SI5_READOUT_FRAME_LEN = 130;

/**
 * Thrown by a readout-station backup read that could not fetch every page.
 * Nothing may be cleared after this: the pages that did arrive are not the
 * whole record of the event.
 */
export class BackupReadIncompleteError extends Error {
  readonly address: number;
  constructor(address: number) {
    super(`Backup read incomplete at 0x${address.toString(16)}`);
    this.name = "BackupReadIncompleteError";
    this.address = address;
  }
}

// ─── Connection class ──────────────────────────────────────

let nextSerialReaderId = 1;

function readerModeOf(mode: number): SIReaderMode {
  if (isReadoutMode(mode)) return "readout";
  return "other";
}

export class SIReaderConnection extends EventTarget implements SIReader {
  readonly kind = "serial" as const;
  readonly supportsStationProgramming = true;
  readonly id = `serial:${nextSerialReaderId++}`;
  private _info: SIReaderDeviceInfo | null = null;

  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private buffer = new Uint8Array(0);
  private _status: SIReaderStatus = "idle";
  private reading = false;

  // Readout state machine
  private pendingCardType: SICardType | null = null;
  private pendingCardNumber = 0;
  private pendingBlocks: Uint8Array[] = [];
  private pendingBlockIndex = 0;
  private pendingTotalBlocks = 0;
  /** Re-requests used for the block being waited on (one allowed). */
  private pendingBlockRetries = 0;
  private blockTimeoutId: ReturnType<typeof setTimeout> | null = null;

  // Mode tracking — true when BSM8 is in remote mode (coupling coil)
  private _inRemoteMode = false;

  get inRemoteMode(): boolean {
    return this._inRemoteMode;
  }

  get status(): SIReaderStatus {
    return this._status;
  }

  get isConnected(): boolean {
    return (
      this._status === "connected" || this._status === "reading"
    );
  }

  get portInfo(): SerialPortInfoLike | undefined {
    return this.port?.getInfo();
  }

  /** Station identity learned from SYS_VAL on connect (null until then). */
  get info(): SIReaderDeviceInfo | null {
    return this._info;
  }

  get label(): string {
    const model = this._info?.model;
    const serial = this._info?.serial;
    if (model && serial) return `${model} #${serial}`;
    if (serial) return `SI station #${serial}`;
    return "USB SI station";
  }

  // ── Connection management ──────────────────────────────

  /**
   * Open the browser's serial port picker and connect.
   */
  async connect(): Promise<void> {
    if (!("serial" in navigator)) {
      throw new Error("WebSerial not supported in this browser");
    }

    // A reader that is already connected stays untouched while the picker is
    // open: cancelling must not strand it.
    const hadPort = this.port !== null;
    if (!hadPort) this.setStatus("connecting");
    let port: SerialPortLike;
    try {
      port = await (navigator as Navigator & { serial: NavigatorSerialLike }).serial.requestPort();
    } catch (err) {
      // A cancelled picker (NotFoundError) is not a reader fault.
      const cancelled = err instanceof Error && err.name === "NotFoundError";
      if (!hadPort) this.setStatus(cancelled ? "idle" : "error");
      throw err;
    }
    try {
      await this.connectToPort(port);
    } catch (err) {
      await this.disconnect();
      this.setStatus("error");
      throw err;
    }
  }

  /**
   * Try to reconnect to a previously authorized port (no picker).
   */
  async tryAutoReconnect(): Promise<boolean> {
    if (!("serial" in navigator)) return false;
    try {
      const ports = await SIReaderConnection.grantedPorts();
      if (ports.length === 0) return false;
      this.setStatus("connecting");
      await this.connectToPort(ports[0]);
      return true;
    } catch {
      await this.disconnect();
      return false;
    }
  }

  /**
   * Open a port the origin already has permission for (from `grantedPorts()`),
   * without showing the picker. Used to restore several readers on load.
   */
  async attach(port: SerialPortLike): Promise<void> {
    this.setStatus("connecting");
    try {
      await this.connectToPort(port);
    } catch (err) {
      await this.disconnect();
      this.setStatus("error");
      throw err;
    }
  }

  /** True when this connection holds the given port object. */
  holdsPort(port: SerialPortLike): boolean {
    return this.port === port;
  }

  private async connectToPort(port: SerialPortLike): Promise<void> {
    // Release a port still held (a second connect, or a reader that died
    // without a clean close) so it is not left open with nobody reading it.
    if (this.port) await this.disconnect();
    this.setStatus("connecting");
    this.port = port;
    await port.open(SERIAL_OPTIONS);
    this.setStatus("connected");
    this.startReadLoop();

    // Ensure BSM8 starts in direct mode for card readout.
    // Handles: page reload while stuck in remote, auto-reconnect, fresh connect.
    try {
      await this.sendAndWait(buildSetDirectMode(), CMD.SET_MS, 2000);
      this._inRemoteMode = false;
    } catch {
      // Non-fatal — station may not be ready yet
    }

    // Validate and fix station protocol + feedback settings.
    // Required: extended protocol ON, handshake ON (for ACK-triggered beep),
    // optical + acoustic feedback ON.
    try {
      await this.ensureStationConfig();
    } catch {
      // Non-fatal — station may not support SYS_VAL reads (old firmware)
    }
  }

  /**
   * Read station PROTO and FEEDBACK config; fix bits if needed.
   * - PROTO (0x74): bit0=extended, bit1=autosend, bit2=handshake
   *   We need: extended=1, handshake=1, autosend=0
   * - FEEDBACK (0x73): bit0=optical, bit1=acoustic, bits6-7=station code high
   *   We need: optical=1, acoustic=1 (preserve bits 2-7)
   */
  private async ensureStationConfig(): Promise<void> {
    const resp = await this.sendAndWait(
      buildGetSysVal(),
      CMD.GET_SYSTEM_VALUE,
      3000,
    );
    // Response: [0x00, station_id, echoed_offset, ...128 bytes SYS_VAL]
    const P = 3; // data payload offset
    if (resp.data.length < P + SYSVAL.FEEDBACK + 1 || resp.data.length < P + SYSVAL.PROTO + 1) {
      throw new Error(`SYS_VAL reply too short (${resp.data.length} bytes)`);
    }

    const station = parseStationInfo(resp.data);
    if (station) {
      this._info = {
        serial: station.serialNo || null,
        firmware: station.firmwareVersion || null,
        model: station.modelName || null,
        mode: readerModeOf(station.mode),
      };
      this.dispatchEvent(
        new CustomEvent("si:reader-info", { detail: this._info }),
      );
    }

    const proto = resp.data[P + SYSVAL.PROTO];
    const feedback = resp.data[P + SYSVAL.FEEDBACK];

    // PROTO: ensure extended(bit0)=1, handshake(bit2)=1
    const wantProto = (proto | 0x05) & ~0x02; // set ext+handshake, clear autosend
    if (wantProto !== proto) {
      siLog(`Fixing PROTO: 0x${proto.toString(16)} → 0x${wantProto.toString(16)}`);
      await this.sendAndWait(
        buildSetSysVal(SYSVAL.PROTO, wantProto),
        CMD.SET_SYSTEM_VALUE,
      );
    }

    // FEEDBACK: ensure optical(bit0)=1, acoustic(bit1)=1, preserve upper bits
    const wantFeedback = feedback | 0x03;
    if (wantFeedback !== feedback) {
      siLog(`Fixing FEEDBACK: 0x${feedback.toString(16)} → 0x${wantFeedback.toString(16)}`);
      await this.sendAndWait(
        buildSetSysVal(SYSVAL.FEEDBACK, wantFeedback),
        CMD.SET_SYSTEM_VALUE,
      );
    }
  }

  /**
   * Disconnect and release the port.
   */
  async disconnect(): Promise<void> {
    this.reading = false;
    this._inRemoteMode = false;
    try {
      if (this.reader) {
        await this.reader.cancel();
        this.reader.releaseLock();
        this.reader = null;
      }
    } catch {
      /* ignore */
    }
    try {
      if (this.port) {
        await this.port.close();
      }
    } catch {
      /* ignore */
    }
    this.port = null;
    this.buffer = new Uint8Array(0);
    this.clearReadoutState();
    this.rejectPendingCommand(new Error("Reader disconnected"));
    this.setStatus("idle");
  }

  /** Fail the command being waited on, if any (the port it was sent to is gone). */
  private rejectPendingCommand(err: Error): void {
    const resolver = this.commandResolver;
    if (!resolver) return;
    this.commandResolver = null;
    clearTimeout(resolver.timeoutId);
    resolver.reject(err);
  }

  // ── Write ──────────────────────────────────────────────

  private async write(data: Uint8Array): Promise<void> {
    if (!this.port?.writable) return;
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  }

  // ── Read loop ──────────────────────────────────────────

  private async startReadLoop(): Promise<void> {
    // Work on the port captured here: a later connect() may swap this.port
    // while this loop is still unwinding.
    const port = this.port;
    if (!port?.readable) return;
    this.reading = true;
    this.setStatus("reading");

    let errored = false;
    let lastStream: ReadableStream<Uint8Array> | null = null;
    while (port.readable && this.reading && this.port === port) {
      // The browser hands out a fresh stream after a recoverable error. The
      // same errored stream again means it did not recover.
      if (port.readable === lastStream) break;
      lastStream = port.readable;
      const reader = port.readable.getReader();
      this.reader = reader;
      if (errored) {
        errored = false;
        this.setStatus("reading");
      }
      try {
        while (this.reading) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            this.appendToBuffer(value);
            this.processBuffer();
          }
        }
      } catch (err) {
        console.error("[SIReader] read error:", err);
        if (this.reading && this.port === port) {
          // Recoverable if the port offers a new stream; reported until then.
          errored = true;
          this.setStatus("error");
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* ignore */
        }
        if (this.reader === reader) this.reader = null;
      }
    }

    // Left the loop while still meant to be reading: the port is gone for good
    // (unplugged, or a fatal stream error). Do not leave the state machine
    // half-way: fail the open read and command, release the port, so a later
    // attach() of the same port starts clean.
    if (this.reading && this.port === port) {
      this.reading = false;
      this.failReadout("removed");
      this.rejectPendingCommand(new Error("Reader disconnected"));
      this.buffer = new Uint8Array(0);
      this._inRemoteMode = false;
      try {
        await port.close();
      } catch {
        /* already gone */
      }
      // A new port may have been attached while the close was pending: it is
      // not ours to null or to mark as errored.
      if (this.port === port) {
        this.port = null;
        this.setStatus("error");
      }
    }
  }

  private appendToBuffer(data: Uint8Array): void {
    const combined = new Uint8Array(this.buffer.length + data.length);
    combined.set(this.buffer);
    combined.set(data, this.buffer.length);
    this.buffer = combined;
    // Prevent unbounded growth
    if (this.buffer.length > 4096) {
      this.buffer = this.buffer.slice(-2048);
    }
  }

  // ── Frame processing ───────────────────────────────────

  private processBuffer(): void {
    let result = extractFrame(this.buffer);
    while (result) {
      this.buffer = Uint8Array.from(result.remaining);
      this.handleFrame(result.frame);
      result = extractFrame(this.buffer);
    }
  }

  private handleFrame(frame: SIParsedFrame): void {
    // A frame whose CRC does not match was damaged on the wire. Nothing in it
    // can be trusted, so it is dropped; a pending readout block is asked for
    // again straight away (that is its one retry), a pending command times out
    // and is retried by its caller as before.
    if (!frame.crcValid) {
      siWarn(
        `Dropped frame with bad CRC cmd=0x${frame.cmd.toString(16)} len=${frame.data.length}`,
      );
      if (this.pendingCardType && isReadoutResponse(frame.cmd)) {
        this.retryOrFail("bad-block");
      }
      return;
    }

    // Check if this frame satisfies a pending command response
    if (this.checkCommandResponse(frame)) return;

    // Card detection
    if (isDetectionCommand(frame.cmd)) {
      siLog(
        `Detection cmd=0x${frame.cmd.toString(16)} len=${frame.data.length} data=[${Array.from(frame.data).map((b) => "0x" + b.toString(16).padStart(2, "0")).join(", ")}]`,
      );
      const detection = parseCardDetection(frame.cmd, frame.data);
      if (detection) {
        siLog(
          `Detected card #${detection.cardNumber} type=${detection.cardType}`,
        );
        // A new card while the previous read is still open: the old one is
        // gone. Fail it first, so its failure event cannot arrive after (and
        // be mistaken for a failure of) the card detected now.
        if (this.pendingCardType) this.failReadout("removed");
        this.dispatchEvent(
          new CustomEvent("si:card-detected", { detail: detection }),
        );
        // Auto-send readout commands
        this.initiateReadout(detection).catch((err) => {
          siWarn("Readout start failed:", err);
          this.failReadout("bad-block");
        });
      }
      return;
    }

    // Card removed
    if (frame.cmd === CMD.CARD_REMOVED) {
      // Card lifted before the read finished: report it, the card was not read.
      if (this.pendingCardType) this.failReadout("removed");
      this.dispatchEvent(
        new CustomEvent("si:card-removed", { detail: {} }),
      );
      return;
    }

    // Readout response
    if (isReadoutResponse(frame.cmd)) {
      this.handleReadoutBlock(frame).catch((err) => {
        siWarn("Readout block failed:", err);
        this.failReadout("bad-block");
      });
      return;
    }

    // Transmit record (online punch)
    if (frame.cmd === CMD.TRANSMIT_RECORD || frame.cmd === CMD.SRR_PUNCH) {
      const punch = parseTransmitRecord(frame.data);
      if (punch) {
        this.dispatchEvent(
          new CustomEvent("si:punch", { detail: punch }),
        );
      }
    }
  }

  // ── Readout state machine ──────────────────────────────

  private async initiateReadout(detection: SICardDetection): Promise<void> {
    // Auto-restore direct mode if stuck in remote (e.g. after programming/readout)
    if (this._inRemoteMode) {
      try {
        await this.restoreDirectMode();
      } catch {
        // If restore fails, attempt readout anyway
      }
    }

    const { cardType } = detection;

    if (!supportsFullReadout(cardType)) {
      // SI6 detection only — emit a minimal readout with just the card number
      const partial: SICardReadout = {
        cardNumber: detection.cardNumber,
        cardType: detection.cardType,
        checkTime: null,
        startTime: null,
        finishTime: null,
        clearTime: null,
        punches: [],
        punchCount: 0,
      };
      this.dispatchEvent(
        new CustomEvent("si:card-readout", { detail: partial }),
      );
      return;
    }

    this.pendingCardType = cardType;
    this.pendingCardNumber = detection.cardNumber;
    this.pendingBlocks = [];
    this.pendingBlockIndex = 0;
    this.pendingBlockRetries = 0;
    // Small cards: BLOCKS_TO_READ blocks (SI5 1, SI8/SI9/pCard 2). Large cards
    // start at the full 8 and shrink after block 0 reveals the punch count.
    this.pendingTotalBlocks = BLOCKS_TO_READ[cardType] ?? 1;

    this.resetBlockTimeout();
    await this.requestBlock(cardType, 0);
  }

  /** Timer for the block being waited on: ask once more, then give up. */
  private resetBlockTimeout(): void {
    if (this.blockTimeoutId) clearTimeout(this.blockTimeoutId);
    this.blockTimeoutId = setTimeout(() => {
      this.blockTimeoutId = null;
      if (this.pendingCardType) this.retryOrFail("timeout");
    }, BLOCK_TIMEOUT_MS);
  }

  /**
   * Re-request the block being waited on, once per block. The second failure
   * of the same block fails the whole read.
   */
  private retryOrFail(reason: SICardReadFailureReason): void {
    const cardType = this.pendingCardType;
    if (!cardType) return;
    if (this.pendingBlockRetries >= 1) {
      this.failReadout(reason);
      return;
    }
    this.pendingBlockRetries++;
    siWarn(
      `Readout block ${this.pendingBlockIndex} of card ${this.pendingCardNumber}: ${reason}, asking again`,
    );
    this.resetBlockTimeout();
    this.requestBlock(cardType, this.pendingBlockIndex).catch((err) => {
      siWarn("Readout re-request failed:", err);
      this.failReadout("bad-block");
    });
  }

  private clearReadoutState(): void {
    if (this.blockTimeoutId) {
      clearTimeout(this.blockTimeoutId);
      this.blockTimeoutId = null;
    }
    this.pendingCardType = null;
    this.pendingCardNumber = 0;
    this.pendingBlocks = [];
    this.pendingBlockIndex = 0;
    this.pendingTotalBlocks = 0;
    this.pendingBlockRetries = 0;
  }

  /**
   * Give up on the card being read. No ACK is sent (the station does not beep,
   * which tells the runner at the reader the card was not taken) and no
   * readout event is emitted; `si:card-read-failed` tells the UI to say so.
   */
  private failReadout(reason: SICardReadFailureReason): void {
    const cardType = this.pendingCardType;
    if (!cardType) return;
    const detail: SICardReadFailure = {
      cardNumber: this.pendingCardNumber,
      cardType,
      reason,
      blocksReceived: this.pendingBlocks.length,
      blocksExpected: this.pendingTotalBlocks,
    };
    siWarn(
      `Card ${detail.cardNumber} (${cardType}) not read: ${reason}, ` +
        `${detail.blocksReceived}/${detail.blocksExpected} blocks`,
    );
    this.clearReadoutState();
    this.dispatchEvent(new CustomEvent("si:card-read-failed", { detail }));
  }

  private async requestBlock(
    cardType: SICardType,
    blockNumber: number,
  ): Promise<void> {
    const cmd = buildReadCommand(cardType, blockNumber);
    await this.write(cmd);
  }

  private async handleReadoutBlock(frame: SIParsedFrame): Promise<void> {
    if (!this.pendingCardType) return;

    siLog(
      `Readout block cmd=0x${frame.cmd.toString(16)} type=${this.pendingCardType} len=${frame.data.length} first32=[${Array.from(frame.data.slice(0, 32)).map((b) => "0x" + b.toString(16).padStart(2, "0")).join(", ")}]`,
    );

    // Frame shapes (extended protocol):
    //   SI8+ (0xEF): StationCode(2) + BlockNumber(1) + BlockData(128) = 131 bytes
    //   SI5  (0xB1): StationCode(2) + BlockData(128)                   = 130 bytes
    // Anything else is not a block of this card: drop it and ask again.
    let blockData: Uint8Array;
    if (this.pendingCardType === "SI5") {
      if (frame.cmd !== CMD.SI5_READ || frame.data.length !== SI5_READOUT_FRAME_LEN) {
        this.retryOrFail("bad-block");
        return;
      }
      blockData = frame.data.slice(2);
    } else {
      if (frame.cmd !== CMD.SI8_READ || frame.data.length !== READOUT_BLOCK_FRAME_LEN) {
        this.retryOrFail("bad-block");
        return;
      }
      const blockNumber = frame.data[2];
      // A repeat of a block already taken (late answer to a re-request): ignore.
      if (blockNumber < this.pendingBlockIndex) return;
      if (blockNumber !== this.pendingBlockIndex) {
        this.retryOrFail("bad-block");
        return;
      }
      blockData = frame.data.slice(3);
      // Block 0 carries the card number (bytes 25-27, 3 bytes big-endian). A
      // block of another card (swapped in mid-read) must not be mixed in.
      if (
        blockNumber === 0 &&
        this.pendingCardNumber > 0 &&
        ((blockData[25] << 16) | (blockData[26] << 8) | blockData[27]) !==
          (this.pendingCardNumber & 0xffffff)
      ) {
        this.retryOrFail("bad-block");
        return;
      }
    }

    this.pendingBlocks.push(blockData);
    this.pendingBlockIndex++;
    this.pendingBlockRetries = 0;

    // After block 0 of a large card the punch count says how many punch blocks
    // follow: blocks 0-3 are header + personal data, blocks 4.. hold 32 slots each.
    if (
      this.pendingBlockIndex === 1 &&
      isLargeCardType(this.pendingCardType)
    ) {
      const punchCount = blockData[22];
      const punchBlocksNeeded = Math.min(
        4,
        Math.max(1, Math.ceil(punchCount / 32)),
      );
      this.pendingTotalBlocks = 4 + punchBlocksNeeded;
    }
    // SI8/SI9/pCard: the punch area spans blocks 0 and 1 whatever the counter
    // says (slots start at image byte 56/136/176), so both blocks are always
    // read; pendingTotalBlocks was set from BLOCKS_TO_READ.

    if (this.pendingBlockIndex < this.pendingTotalBlocks) {
      this.resetBlockTimeout();
      await this.requestBlock(this.pendingCardType, this.pendingBlockIndex);
    } else {
      this.finalizeReadout();
    }
  }

  private finalizeReadout(): void {
    const cardType = this.pendingCardType;
    if (!cardType) return;

    // Never parse a partial card: a half-read SI8 would look like a card with
    // fewer punches and be filed as a (wrong) result.
    if (this.pendingBlocks.length !== this.pendingTotalBlocks) {
      this.failReadout("bad-block");
      return;
    }

    let readout;
    if (cardType === "SI5") {
      readout = parseSI5CardData(this.pendingBlocks);
    } else if (isLargeCardType(cardType)) {
      readout = parseSI10CardData(this.pendingBlocks);
    } else {
      readout = parseSI8CardData(this.pendingBlocks);
    }

    if (!readout) {
      this.failReadout("parse");
      return;
    }

    const cardNumber = this.pendingCardNumber;
    this.clearReadoutState();

    // Use the card number from the detection event as the source of truth
    if (cardNumber > 0) {
      readout.cardNumber = cardNumber;
    }

    if (readout.batteryVoltage) {
      siLog(`Battery voltage: ${readout.batteryVoltage.toFixed(2)}V`);
    }

    // Send ACK to station — triggers built-in feedback (beep + LED blink)
    this.write(new Uint8Array([ACK])).catch(() => {});

    this.dispatchEvent(
      new CustomEvent("si:card-readout", { detail: readout }),
    );
  }

  // ── Station programming ──────────────────────────────────

  /** Pending command response resolver for request/response flow */
  private commandResolver: {
    cmd: number;
    /** When set, a frame it rejects is dropped and the command keeps waiting. */
    accept?: (frame: SIParsedFrame) => boolean;
    resolve: (frame: SIParsedFrame) => void;
    reject: (err: Error) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  } | null = null;

  /** Send a command and wait for a specific response command byte */
  private async sendAndWait(
    data: Uint8Array,
    expectedCmd: number,
    timeoutMs = 3000,
    accept?: (frame: SIParsedFrame) => boolean,
  ): Promise<SIParsedFrame> {
    // Cancel any previous pending command
    if (this.commandResolver) {
      this.commandResolver.reject(new Error("Superseded by new command"));
      clearTimeout(this.commandResolver.timeoutId);
      this.commandResolver = null;
    }

    return new Promise<SIParsedFrame>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.commandResolver = null;
        reject(
          new Error(
            `Timeout waiting for response 0x${expectedCmd.toString(16)}`,
          ),
        );
      }, timeoutMs);

      this.commandResolver = { cmd: expectedCmd, accept, resolve, reject, timeoutId };
      this.write(data).catch((err) => {
        clearTimeout(timeoutId);
        this.commandResolver = null;
        reject(err);
      });
    });
  }

  /**
   * Send a command with retry — for remote/indirect mode where the field
   * control may need extra time to wake up from sleep.
   */
  private async sendAndWaitRetry(
    data: Uint8Array,
    expectedCmd: number,
    timeoutMs = 5000,
    retries = 2,
  ): Promise<SIParsedFrame> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) {
          // Brief pause between retries — each attempt activates the coupling
          // coil which helps wake sleeping field controls.
          const delayMs = Math.min(attempt * 500, 2000);
          siLog(`Retry ${attempt}/${retries}`);
          await new Promise((r) => setTimeout(r, delayMs));
        }
        return await this.sendAndWait(data, expectedCmd, timeoutMs);
      } catch (err) {
        if (attempt === retries) throw err;
      }
    }
    throw new Error("Unreachable");
  }

  /** Check if a frame matches a pending command response */
  private checkCommandResponse(frame: SIParsedFrame): boolean {
    if (this.commandResolver && frame.cmd === this.commandResolver.cmd) {
      // A late answer to an earlier request (another address, wrong length):
      // swallow it and keep waiting for the one this command asked for.
      if (this.commandResolver.accept && !this.commandResolver.accept(frame)) {
        siWarn(`Discarded unexpected 0x${frame.cmd.toString(16)} reply (${frame.data.length} bytes)`);
        return true;
      }
      clearTimeout(this.commandResolver.timeoutId);
      const resolver = this.commandResolver;
      this.commandResolver = null;
      resolver.resolve(frame);
      return true;
    }
    return false;
  }

  /**
   * Wake a sleeping field control by sending GET_SYS_VAL probes through
   * the coupling coil. Each GET_SYS_VAL activates the coil; the control
   * typically responds after 1-3 attempts.
   *
   * Matches Config+'s wake cadence: SET_MS REMOTE is sent only once (if
   * not already in remote mode) and GET_SYS_VAL retries are back-to-back
   * with a ~550 ms per-attempt timeout (Config+ retries at ~535 ms).
   */
  private async wakeAndReadSysVal(): Promise<SIParsedFrame> {
    if (!this._inRemoteMode) {
      await this.sendAndWait(buildSetRemoteMode(), CMD.SET_MS, 1500);
      this._inRemoteMode = true;
    }

    const maxAttempts = 10;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        if (attempt > 0) siLog(`Wake attempt ${attempt + 1}/${maxAttempts}`);
        return await this.sendAndWait(
          buildGetSysVal(),
          CMD.GET_SYSTEM_VALUE,
          550,
        );
      } catch (err) {
        if (attempt === maxAttempts - 1) throw err;
        // No extra sleep — the 550 ms timeout above already paces retries
        // to match Config+'s ~535 ms cadence.
      }
    }
    throw new Error("Unreachable");
  }

  /**
   * Read the coupled field control's configuration.
   * Uses remote/indirect mode so commands are forwarded from the BSM8
   * USB master station to the coupled field control via the coupling stick.
   */
  async readConnectedStation(): Promise<StationInfo & { rawData: Uint8Array }> {
    const t0 = performance.now();
    const response = await this.wakeAndReadSysVal();
    siLog(`${(performance.now() - t0).toFixed(0)}ms GET_SYS_VAL(read)`);
    const info = parseStationInfo(response.data);
    if (!info) throw new Error("Failed to parse station info");

    this.dispatchEvent(
      new CustomEvent("si:station-read", { detail: info }),
    );
    return { ...info, rawData: response.data };
  }

  /**
   * Read the *directly-connected* USB station's own SYS_VAL — different
   * from `readConnectedStation()` which queries a field station coupled
   * to the connected master.
   *
   * Required when reading the backup memory of a BSM-family readout
   * station that's plugged in directly (no coupler), e.g. recovering
   * readouts captured by a USB master station after the competition.
   * Switches to DIRECT mode (the master answers for itself instead of
   * forwarding via the coupling coil).
   */
  async readLocalStation(): Promise<StationInfo & { rawData: Uint8Array }> {
    if (this._inRemoteMode) {
      await this.sendAndWait(buildSetDirectMode(), CMD.SET_MS, 1500);
      this._inRemoteMode = false;
    }
    const response = await this.sendAndWaitRetry(
      buildGetSysVal(),
      CMD.GET_SYSTEM_VALUE,
    );
    const info = parseStationInfo(response.data);
    if (!info) throw new Error("Failed to parse local station info");
    this.dispatchEvent(
      new CustomEvent("si:station-read", { detail: info }),
    );
    return { ...info, rawData: response.data };
  }

  /**
   * Quick probe for a coupled field control. Returns station info if one is
   * present on the coupling stick, or null if nothing responds (timeout).
   *
   * Designed to match Config+'s wake cadence: SET_MS REMOTE is sent at most
   * once per "polling session" (whenever the BSM8 is not already in remote
   * mode), and every subsequent probe is a bare GET_SYS_VAL that activates
   * the coupling coil. Timeout is tuned to ~535 ms which is what Config+
   * uses between GET_SYS_VAL retries when waking a sleeping station.
   */
  async probeConnectedStation(): Promise<(StationInfo & { rawData: Uint8Array }) | null> {
    try {
      // Only re-enter remote mode if we're not already there. Avoids the
      // extra SET_MS roundtrip per probe — Config+ never re-sends SET_MS
      // between GET_SYS_VAL retries.
      if (!this._inRemoteMode) {
        await this.sendAndWait(buildSetRemoteMode(), CMD.SET_MS, 1000);
        this._inRemoteMode = true;
      }
      // Each attempt activates the coupling coil, which is what actually
      // wakes a sleeping control.
      const response = await this.sendAndWait(
        buildGetSysVal(),
        CMD.GET_SYSTEM_VALUE,
        550,
      );
      const info = parseStationInfo(response.data);
      if (!info) return null;
      return { ...info, rawData: response.data };
    } catch {
      return null;
    }
  }

  /**
   * Program a field control: set mode, station code, autosend, auto-off,
   * sync time, erase backup.
   *
   * Matches what Config+ 2.11.0 does on the wire: a single bulk
   * SET_SYS_VAL covering offsets 0x10-0x7F (112 bytes), copying the
   * current SYS_VAL bytes and mutating only the few fields we change.
   * This replaces the old 5-write loop and matches Config+ atomicity.
   *
   * SRR_CFG (offset 0x04) is intentionally NOT written — Config+
   * never touches it during programming, treating it as a one-time
   * factory/admin setting. The `enableSRR` parameter is accepted for
   * backwards compatibility but ignored.
   *
   * @param preReadData — raw GET_SYS_VAL response from readConnectedStation,
   *   used to seed the bulk write buffer. Pass this to avoid a redundant
   *   remote switch + read.
   */
  async programControl(config: {
    code: number;
    /** @deprecated Config+ never writes SRR_CFG during programming. */
    enableSRR?: boolean;
    enableAirPlus: boolean;
    autosendMode?: AutosendMode;
    awakeHours?: number;
    beep?: boolean;
    stationMode?: number;
  }, preReadData?: Uint8Array): Promise<{ batteryVoltage: number; stationInfo: StationInfo; timeDriftMs: number | null }> {
    let stationInfo: StationInfo;
    let sysValData: Uint8Array;

    if (preReadData) {
      // Use pre-read data — skip redundant remote switch + GET_SYS_VAL
      sysValData = preReadData;
      stationInfo = parseStationInfo(preReadData)!;
    } else {
      // Fallback: switch to remote and read
      await this.sendAndWait(buildSetRemoteMode(), CMD.SET_MS);
      this._inRemoteMode = true;
      const readResp = await this.sendAndWaitRetry(
        buildGetSysVal(),
        CMD.GET_SYSTEM_VALUE,
      );
      sysValData = readResp.data;
      stationInfo = parseStationInfo(readResp.data)!;
      if (!stationInfo) throw new Error("Failed to read station before programming");
    }

    const t0 = performance.now();
    const lap = (label: string) => {
      const ms = (performance.now() - t0).toFixed(0);
      siLog(`${ms}ms ${label}`);
    };

    // 1. Build the bulk SET_SYS_VAL payload. Copy the read-back bytes
    //    for offsets 0x10-0x7F into a 112-byte buffer, then mutate only
    //    the fields we want to change. SYS_VAL response has 3 header
    //    bytes before the actual SYS_VAL data (P=3).
    const P = 3;
    if (sysValData.length < P + 0x80) {
      throw new Error(
        `SYS_VAL response too short: ${sysValData.length} bytes (need ${P + 0x80})`,
      );
    }
    const buf = new Uint8Array(112);
    for (let i = 0; i < 112; i++) buf[i] = sysValData[P + 0x10 + i];

    // Resolve operating mode — explicit stationMode wins, else default to
    // BC_CONTROL when AIR+ is enabled, CONTROL otherwise.
    const baseMode =
      config.stationMode ??
      (config.enableAirPlus ? STATION_MODE.BC_CONTROL : STATION_MODE.CONTROL);
    // MODE (0x71) carries the autosend variant for beacon modes only; PROTO
    // (0x74) bit 1 is the mode-independent gate. Read-modify-write on PROTO
    // so extended (bit 0), handshake (bit 2) and friends survive untouched.
    const { modeByte, protoByte } = resolveProgrammingMode({
      baseMode,
      autosendMode: config.autosendMode,
      currentProto: sysValData[P + SYSVAL.PROTO],
    });

    // Station code → CODE byte + high bits into FEEDBACK byte. Force
    // optical (bit 0), acoustic (bit 1), and flash (bit 2) feedback ON
    // unconditionally — Oxygen never wants a station that silently reads
    // cards without LED + beep + flash. encodeStationCode preserves the
    // bits below 0xC0, so OR-ing 0x07 in before the call sticks.
    const feedbackBase = sysValData[P + SYSVAL.FEEDBACK] | 0x07;
    const { codeByte, feedbackByte } = encodeStationCode(
      config.code,
      feedbackBase,
    );

    // Auto power-off (minutes, big-endian uint16). Default to whatever the
    // station already has if not specified.
    let autoOffHi = sysValData[P + SYSVAL.AUTO_OFF];
    let autoOffLo = sysValData[P + SYSVAL.AUTO_OFF + 1];
    if (config.awakeHours !== undefined) {
      const autoOffMinutes = config.awakeHours * 60;
      autoOffHi = (autoOffMinutes >> 8) & 0xff;
      autoOffLo = autoOffMinutes & 0xff;
    }

    // Apply mutations at their respective offsets within the buffer.
    buf[SYSVAL.PROGRAM - 0x10] = 0x30; // ASCII '0' = competition bank
    buf[SYSVAL.MODE - 0x10] = modeByte;
    buf[SYSVAL.STATION_CODE - 0x10] = codeByte;
    buf[SYSVAL.FEEDBACK - 0x10] = feedbackByte;
    buf[SYSVAL.PROTO - 0x10] = protoByte;
    buf[SYSVAL.AUTO_OFF - 0x10] = autoOffHi;
    buf[SYSVAL.AUTO_OFF - 0x10 + 1] = autoOffLo;

    // 2. Single bulk SET_SYS_VAL covering 0x10-0x7F. Use sendAndWaitRetry
    //    because Config+ retried this same payload after 745 ms when no
    //    response came back the first time (capture 3 segment 2).
    await this.sendAndWaitRetry(
      buildCommand(CMD.SET_SYSTEM_VALUE, [0x10, ...buf]),
      CMD.SET_SYSTEM_VALUE,
    );
    lap(`SET_SYS_VAL(bulk 0x10-0x7F, mode=0x${modeByte.toString(16)}, proto=0x${protoByte.toString(16)})`);

    // 3. Sync time
    await this.sendAndWait(buildSetTime(new Date()), CMD.SET_TIME);
    lap("SET_TIME");

    // 4. Read station time immediately to get accurate drift measurement
    const beforeTime = Date.now();
    const timeResp = await this.sendAndWait(
      buildCommand(CMD.GET_TIME),
      CMD.GET_TIME,
    );
    const afterTime = Date.now();
    const timeDriftMs = parseTimeDrift(timeResp.data, beforeTime, afterTime);
    lap(`GET_TIME (rtt=${afterTime - beforeTime}ms, drift=${timeDriftMs}ms)`);

    // 5. Erase backup memory — Config+ sees response in ~65-145ms.
    await this.sendAndWait(buildEraseBackup(), CMD.ERASE_BACKUP, 3000);
    lap("ERASE_BACKUP");

    // 6. Beep to confirm (fire-and-forget)
    if (config.beep !== false) {
      await this.write(buildBeep(1));
    }
    lap("done");

    // 7. Re-read SYS_VAL so battery voltage and other dynamic fields
    //    reflect the now-fully-booted state. The post-boot ADC sample
    //    isn't latched on the very first read after a coil-wake (per SI
    //    BS7/8/9 firmware notes: "Battery voltage is measured after
    //    firmware boot"), which is why freshly-woken units used to report
    //    exactly 3.00V (raw 0x9999).
    let finalInfo = stationInfo;
    try {
      const finalResp = await this.sendAndWait(
        buildGetSysVal(),
        CMD.GET_SYSTEM_VALUE,
        1500, // healthy unit responds in ~300ms; cap at 1.5s on failure
      );
      const parsed = parseStationInfo(finalResp.data);
      if (parsed) finalInfo = parsed;
      lap("GET_SYS_VAL(post-program)");
    } catch {
      // Keep initial info if final read fails.
    }

    this.dispatchEvent(
      new CustomEvent("si:control-programmed", {
        detail: {
          code: config.code,
          batteryVoltage: finalInfo.batteryVoltage,
          stationInfo: finalInfo,
          timeDriftMs,
        },
      }),
    );

    return {
      batteryVoltage: finalInfo.batteryVoltage,
      stationInfo: finalInfo,
      timeDriftMs,
    };
  }

  /**
   * Read the backup memory from the connected station and parse it according
   * to the station's operating mode.
   *
   * - Control-mode stations (M_CONTROL): returns 8-byte BUX punch records.
   * - Readout-mode stations (M_READOUT): returns full card readouts recovered
   *   from the station's backup flash.
   * - Any other mode: throws.
   *
   * @param preReadData — raw GET_SYS_VAL response captured during a recent
   *   probe. When provided, skips the redundant SYS_VAL read at the start.
   */
  async readBackupMemory(preReadData?: Uint8Array): Promise<BackupResult> {
    let sysValData: Uint8Array;
    if (preReadData) {
      sysValData = preReadData;
    } else {
      // Wake + read SYS_VAL (handles sleeping controls via coupling coil)
      const sysResp = await this.wakeAndReadSysVal();
      sysValData = sysResp.data;
    }
    const info = parseStationInfo(sysValData);
    if (!info) throw new Error("Failed to read station info");
    siLog(
      `Backup read: station code=${info.stationCode}, serial=${info.serialNo}, ` +
      `mode=0x${info.mode.toString(16)} (${stationModeLabel(info.mode)})`,
    );

    // Backup pointer from SYS_VAL is the write position (next free address).
    // After ERASE_BACKUP it resets to 0x100 (data start). Data lives at 0x100..pointer.
    const endAddr = info.backupPointer;
    siLog(
      `Backup pointer: 0x${endAddr.toString(16)} (~${info.backupCount} records), ` +
      `mem=${info.memSizeKB}KB`,
    );

    if (isControlMode(info.mode)) {
      return this._readControlBackup(info, endAddr);
    }
    if (isReadoutMode(info.mode)) {
      return this._readReadoutBackup(info, endAddr);
    }
    throw new Error(
      `Unsupported station mode for backup readback: 0x${info.mode.toString(16)} (${stationModeLabel(info.mode)})`,
    );
  }

  /**
   * Walk backup flash from 0x100 to `endAddr` in 0x80-byte pages, returning
   * the raw data bytes (without the 5-byte response header). Shared by both
   * control- and readout-mode backup reads.
   */
  private async _walkBackupPages(
    endAddr: number,
  ): Promise<{ raw: Uint8Array[]; pageAddresses: number[] }> {
    const raw: Uint8Array[] = [];
    const pageAddresses: number[] = [];
    let readAddr = 0x100;
    while (readAddr < endAddr) {
      const count = Math.min(0x80, endAddr - readAddr);
      const adr2 = (readAddr >> 16) & 0xff;
      const adr1 = (readAddr >> 8) & 0xff;
      const adr0 = readAddr & 0xff;
      // The reply echoes the address: [0x00, station, adr2, adr1, adr0, ...count bytes].
      // A late answer to an earlier page must never be taken for this one.
      const isThisPage = (f: SIParsedFrame): boolean =>
        f.data.length === 5 + count &&
        f.data[2] === adr2 &&
        f.data[3] === adr1 &&
        f.data[4] === adr0;

      let resp: SIParsedFrame | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          if (attempt > 0) {
            // Retry the GET_BACKUP without touching DIRECT/REMOTE mode —
            // the caller already configured the correct mode for whichever
            // station we're reading (coupled field control vs the directly-
            // connected master itself).
            siLog(`Backup page retry ${attempt}/3`);
          }
          resp = await this.sendAndWait(
            buildGetBackup(adr2, adr1, adr0, count, false),
            CMD.GET_BACKUP,
            1500,
            isThisPage,
          );
          break;
        } catch (err) {
          siWarn(`Backup read attempt ${attempt + 1} at 0x${readAddr.toString(16)}:`, err);
        }
      }

      if (!resp) {
        // A gap would silently drop punches, and the caller may be about to
        // erase the station. Fail the whole read instead.
        throw new BackupReadIncompleteError(readAddr);
      }

      raw.push(resp.data);
      pageAddresses.push(readAddr);
      readAddr += count;
    }
    return { raw, pageAddresses };
  }

  /**
   * Control-mode backup: parse each page's 5-byte-header response as a list
   * of 8-byte BUX punch records.
   */
  private async _readControlBackup(
    info: StationInfo,
    endAddr: number,
  ): Promise<BackupResult> {
    if (endAddr <= 0x100) {
      siLog("Backup pointer at start — no data");
      const empty: BackupResult = {
        mode: "control",
        records: [],
        stationSerial: info.serialNo,
        stationCode: info.stationCode,
      };
      this.dispatchEvent(new CustomEvent("si:backup-read", { detail: empty }));
      return empty;
    }

    const { raw, pageAddresses } = await this._walkBackupPages(endAddr);
    const allRecords: BackupRecord[] = [];
    for (let i = 0; i < raw.length; i++) {
      const records = parseBackupPage(raw[i]);
      if (records.length > 0) {
        siLog(`Backup @0x${pageAddresses[i].toString(16)}: ${records.length} records`);
        allRecords.push(...records);
      }
    }
    siLog(`Backup read complete: ${allRecords.length} control-mode records`);
    const result: BackupResult = {
      mode: "control",
      records: allRecords,
      stationSerial: info.serialNo,
      stationCode: info.stationCode,
    };
    this.dispatchEvent(new CustomEvent("si:backup-read", { detail: result }));
    return result;
  }

  /**
   * Readout-mode backup: concatenate the raw 128-byte flash bytes from each
   * page (stripping the 5-byte response header) and hand the contiguous
   * buffer to parseReadoutBackupBuffer().
   */
  private async _readReadoutBackup(
    info: StationInfo,
    endAddr: number,
  ): Promise<BackupResult> {
    if (endAddr <= 0x100) {
      siLog("Backup pointer at start — no data");
      const empty: BackupResult = {
        mode: "readout",
        records: [],
        skippedSlots: [],
        stationSerial: info.serialNo,
        stationCode: info.stationCode,
      };
      this.dispatchEvent(new CustomEvent("si:backup-read", { detail: empty }));
      return empty;
    }

    const { raw, pageAddresses } = await this._walkBackupPages(endAddr);
    // Strip the 5-byte response header [0x00, station_code, adr2, adr1, adr0]
    // and place each page at its own address, so the buffer offsets are flash
    // addresses (the slot walker steps by 0x80 from 0x100). Unfilled bytes
    // stay 0xEE, the empty-flash sentinel.
    const totalLen = endAddr - 0x100;
    const buffer = new Uint8Array(totalLen).fill(0xee);
    for (let i = 0; i < raw.length; i++) {
      buffer.set(raw[i].subarray(5), pageAddresses[i] - 0x100);
    }
    const { records, skipped } = parseReadoutBackupBufferDetailed(buffer, 0x100);
    for (const s of skipped) {
      siWarn(`Backup slot @0x${s.slotAddress.toString(16)} not decoded (${s.reason}): ${s.rawBytesHex}`);
    }
    siLog(`Backup read complete: ${records.length} readout-mode records, ${skipped.length} skipped (from ${totalLen} flash bytes)`);
    const result: BackupResult = {
      mode: "readout",
      records,
      skippedSlots: skipped,
      stationSerial: info.serialNo,
      stationCode: info.stationCode,
    };
    this.dispatchEvent(new CustomEvent("si:backup-read", { detail: result }));
    return result;
  }

  /**
   * Erase backup memory on the connected station/control.
   *
   * Matches Config+ (capture 2 segment 6): SET_MS REMOTE (only if not
   * already), ERASE_BACKUP with a tight timeout (~65-145 ms observed), no
   * extra sleep, no verification read. The station's response confirms the
   * erase completed.
   */
  async clearBackupMemory(): Promise<void> {
    if (!this._inRemoteMode) {
      await this.sendAndWait(buildSetRemoteMode(), CMD.SET_MS);
      this._inRemoteMode = true;
    }
    const resp = await this.sendAndWaitRetry(
      buildEraseBackup(),
      CMD.ERASE_BACKUP,
      1500, // Config+ observes 65-145ms; 1.5s covers worst case
    );
    siLog("Erase response:", Array.from(resp.data).map((b) => b.toString(16).padStart(2, "0")).join(" "));
  }

  /**
   * Power off the connected field control.
   *
   * Matches what Config+ 2.11.0 does in capture 3 segment 4 (standalone
   * switch-off):
   *
   *   1. SET_MS REMOTE (forwards via coupling coil).
   *   2. OFF (LEN=1 param=0x00, with 0xFF wakeup byte). Config+ retried
   *      this command four times at ~540 ms intervals before getting a
   *      response from a sleepy station, so we use sendAndWaitRetry.
   *   3. SET_MS DIRECT (stop coupling-coil pulses so the unit can
   *      actually finish powering down).
   *
   * No pre-OFF settle delay — Config+ goes straight from the SET_MS
   * response to OFF (~16 ms gap).
   */
  async powerOffStation(): Promise<void> {
    await this.sendAndWait(buildSetRemoteMode(), CMD.SET_MS);
    this._inRemoteMode = true;

    // OFF with up to 4 attempts at ~500 ms cadence — Config+ pattern for
    // sleepy/transitioning stations. sendAndWaitRetry uses
    // min(attempt * 500, 2000) ms between attempts; retries=3 gives 4 total.
    try {
      await this.sendAndWaitRetry(
        buildOff(),
        CMD.OFF,
        1500,
        3,
      );
    } catch {
      // Best-effort: unit may sleep before responding to the very last try.
    }

    try {
      await this.sendAndWait(buildSetDirectMode(), CMD.SET_MS, 1000);
      this._inRemoteMode = false;
    } catch {
      // Best-effort cleanup.
    }
  }

  /**
   * Send a beep command to the connected station (fire-and-forget).
   */
  async beep(count = 1): Promise<void> {
    await this.write(buildBeep(count));
  }

  /**
   * Restore the BSM8 to direct (master) mode for normal card readout.
   * Call this after finishing station programming/readout operations.
   */
  async restoreDirectMode(): Promise<void> {
    await this.sendAndWait(buildSetDirectMode(), CMD.SET_MS);
    this._inRemoteMode = false;
  }

  // ── Status management ──────────────────────────────────

  private setStatus(status: SIReaderStatus): void {
    this._status = status;
    this.dispatchEvent(
      new CustomEvent("si:status", { detail: { status } }),
    );
  }

  // ── Static helpers ─────────────────────────────────────

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  /** Ports this origin was granted earlier (no picker, no prompt). */
  static async grantedPorts(): Promise<SerialPortLike[]> {
    if (!SIReaderConnection.isSupported()) return [];
    return (navigator as Navigator & { serial: NavigatorSerialLike }).serial.getPorts();
  }
}
