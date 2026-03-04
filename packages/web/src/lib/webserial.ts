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
  parseSI8CardData,
  parseSI10CardData,
  parseTransmitRecord,
  buildReadCommand,
  isDetectionCommand,
  isReadoutResponse,
  isLargeCardType,
  CMD,
  supportsFullReadout,
  type SICardDetection,
  type SICardReadout,
  type SITransmitPunch,
  type SICardType,
  type SIParsedFrame,
} from "./si-protocol";

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
export interface SIStatusEvent extends CustomEvent {
  detail: { status: SIReaderStatus };
}

// ─── Types ─────────────────────────────────────────────────

export type SIReaderStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reading"
  | "error";

export interface SIReaderInfo {
  status: SIReaderStatus;
  portInfo?: any;
}

// ─── Serial config ─────────────────────────────────────────

const SERIAL_OPTIONS: any = {
  baudRate: 38400,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flowControl: "none",
};

/** Timeout waiting for a single block response */
const BLOCK_TIMEOUT_MS = 2000;

// ─── Connection class ──────────────────────────────────────

export class SIReaderConnection extends EventTarget {
  private port: any | null = null;
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
  private blockTimeoutId: ReturnType<typeof setTimeout> | null = null;

  get status(): SIReaderStatus {
    return this._status;
  }

  get isConnected(): boolean {
    return (
      this._status === "connected" || this._status === "reading"
    );
  }

  get portInfo(): any | undefined {
    return this.port?.getInfo();
  }

  // ── Connection management ──────────────────────────────

  /**
   * Open the browser's serial port picker and connect.
   */
  async connect(): Promise<void> {
    if (!("serial" in navigator)) {
      throw new Error("WebSerial not supported in this browser");
    }

    this.setStatus("connecting");
    try {
      const port = await (navigator as any).serial.requestPort();
      await this.connectToPort(port);
    } catch (err) {
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
      const ports = await (navigator as any).serial.getPorts();
      if (ports.length === 0) return false;
      this.setStatus("connecting");
      await this.connectToPort(ports[0]);
      return true;
    } catch {
      this.setStatus("idle");
      return false;
    }
  }

  private async connectToPort(port: any): Promise<void> {
    this.port = port;
    await port.open(SERIAL_OPTIONS);
    this.setStatus("connected");
    this.startReadLoop();
  }

  /**
   * Disconnect and release the port.
   */
  async disconnect(): Promise<void> {
    this.reading = false;
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
    this.pendingCardType = null;
    this.pendingBlocks = [];
    this.setStatus("idle");
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
    if (!this.port?.readable) return;
    this.reading = true;
    this.setStatus("reading");

    while (this.port.readable && this.reading) {
      this.reader = this.port.readable.getReader();
      try {
        while (this.reading) {
          const { value, done } = await this.reader!.read();
          if (done) break;
          if (value) {
            this.appendToBuffer(value);
            this.processBuffer();
          }
        }
      } catch (err) {
        console.error("[SIReader] read error:", err);
        if (this.reading) {
          // Unexpected disconnect
          this.setStatus("error");
        }
      } finally {
        try {
          this.reader?.releaseLock();
        } catch {
          /* ignore */
        }
        this.reader = null;
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
    // Card detection
    if (isDetectionCommand(frame.cmd)) {
      const detection = parseCardDetection(frame.cmd, frame.data);
      if (detection) {
        this.dispatchEvent(
          new CustomEvent("si:card-detected", { detail: detection }),
        );
        // Auto-send readout commands
        this.initiateReadout(detection);
      }
      return;
    }

    // Card removed
    if (frame.cmd === CMD.CARD_REMOVED) {
      this.dispatchEvent(
        new CustomEvent("si:card-removed", { detail: {} }),
      );
      return;
    }

    // Readout response
    if (isReadoutResponse(frame.cmd)) {
      this.handleReadoutBlock(frame);
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
    const { cardType } = detection;

    if (!supportsFullReadout(cardType)) {
      // SI5/SI6 detection only — emit a minimal readout with just the card number
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

    // Start with block 0 — we'll decide how many more to read based on punch count
    this.pendingCardType = cardType;
    this.pendingCardNumber = detection.cardNumber;
    this.pendingBlocks = [];
    this.pendingBlockIndex = 0;
    this.pendingTotalBlocks = 1; // Start with just block 0

    await this.requestBlock(cardType, 0);
    this.resetBlockTimeout();
  }

  private resetBlockTimeout(): void {
    if (this.blockTimeoutId) clearTimeout(this.blockTimeoutId);
    this.blockTimeoutId = setTimeout(() => {
      if (this.pendingCardType) {
        // Timed out waiting for a block — emit what we have
        this.finalizeReadout();
      }
    }, BLOCK_TIMEOUT_MS);
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

    // The readout response data format (BSF8 mode):
    //   StationCode(2) + BlockNumber(1) + BlockData(128) = 131 bytes
    // For shorter responses, extract the last 128 bytes.
    let blockData: Uint8Array;
    if (frame.data.length >= 128) {
      // Always take the last 128 bytes — this handles all prefix variants:
      // 131 bytes: StationCode(2) + BN(1) + BlockData(128)
      // 130 bytes: StationCode(2) + BlockData(128)
      // 129 bytes: BN(1) + BlockData(128)
      // 128 bytes: BlockData(128)
      blockData = frame.data.slice(frame.data.length - 128);
    } else {
      return; // too short
    }

    this.pendingBlocks.push(blockData);
    this.pendingBlockIndex++;

    // After block 0: decide how many more blocks to read based on card type
    if (this.pendingBlockIndex === 1 && this.pendingBlocks.length === 1) {
      const punchCount = blockData[22]; // punch count byte in SI8+ block 0

      if (isLargeCardType(this.pendingCardType)) {
        // SI10/SI11/SIAC: blocks 0-3 = header + personal data, blocks 4-7 = punches
        // Always read blocks 0-3 for personal data
        const punchSlotsPerBlock = 32; // 128 / 4
        const punchBlocksNeeded = Math.min(
          4,
          Math.max(1, Math.ceil(punchCount / punchSlotsPerBlock)),
        );
        // blocks 0-3 (personal) + blocks 4..(4+N-1) (punches)
        this.pendingTotalBlocks = 4 + punchBlocksNeeded;
      } else {
        // SI8/SI9/pCard/tCard: punches start at block 0 offset 32
        const punchSlotsInBlock0 = 24; // (128 - 32) / 4
        const punchSlotsPerExtraBlock = 32; // 128 / 4

        if (punchCount > punchSlotsInBlock0) {
          const extraPunches = punchCount - punchSlotsInBlock0;
          const extraBlocks = Math.ceil(
            extraPunches / punchSlotsPerExtraBlock,
          );
          this.pendingTotalBlocks = 1 + extraBlocks;
        }
        // Otherwise pendingTotalBlocks stays at 1 — block 0 is enough
      }
    }

    if (this.pendingBlockIndex < this.pendingTotalBlocks) {
      // Request next block
      await this.requestBlock(this.pendingCardType, this.pendingBlockIndex);
      this.resetBlockTimeout();
    } else {
      this.finalizeReadout();
    }
  }

  private finalizeReadout(): void {
    if (this.blockTimeoutId) {
      clearTimeout(this.blockTimeoutId);
      this.blockTimeoutId = null;
    }

    if (this.pendingBlocks.length === 0) {
      this.pendingCardType = null;
      return;
    }

    // Use the correct parser based on card type
    const cardType = this.pendingCardType!;
    const readout = isLargeCardType(cardType)
      ? parseSI10CardData(this.pendingBlocks)
      : parseSI8CardData(this.pendingBlocks);

    const cardNumber = this.pendingCardNumber;
    this.pendingCardType = null;
    this.pendingCardNumber = 0;
    this.pendingBlocks = [];
    this.pendingBlockIndex = 0;
    this.pendingTotalBlocks = 0;

    if (readout) {
      // Use the card number from the detection event as the source of truth
      if (cardNumber > 0) {
        readout.cardNumber = cardNumber;
      }

      if (readout.batteryVoltage) {
        console.log(
          `[SI] Battery voltage: ${readout.batteryVoltage.toFixed(2)}V`,
        );
      }

      this.dispatchEvent(
        new CustomEvent("si:card-readout", { detail: readout }),
      );
    }
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
}
