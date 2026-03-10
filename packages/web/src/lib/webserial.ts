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
  SYSVAL,
  STATION_MODE,
  supportsFullReadout,
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
  type SICardDetection,
  type SICardReadout,
  type SITransmitPunch,
  type SICardType,
  type SIParsedFrame,
  type StationInfo,
  type BackupRecord,
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

    // Ensure BSM8 starts in direct mode for card readout.
    // Handles: page reload while stuck in remote, auto-reconnect, fresh connect.
    try {
      await this.sendAndWait(buildSetDirectMode(), CMD.SET_MS, 2000);
      this._inRemoteMode = false;
    } catch {
      // Non-fatal — station may not be ready yet
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
    // Check if this frame satisfies a pending command response
    if (this.checkCommandResponse(frame)) return;

    // Card detection
    if (isDetectionCommand(frame.cmd)) {
      console.log(
        `[SI] Detection cmd=0x${frame.cmd.toString(16)} len=${frame.data.length} data=[${Array.from(frame.data).map((b) => "0x" + b.toString(16).padStart(2, "0")).join(", ")}]`,
      );
      const detection = parseCardDetection(frame.cmd, frame.data);
      if (detection) {
        console.log(
          `[SI] Detected card #${detection.cardNumber} type=${detection.cardType}`,
        );
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

    console.log(
      `[SI] Readout block cmd=0x${frame.cmd.toString(16)} type=${this.pendingCardType} len=${frame.data.length} first32=[${Array.from(frame.data.slice(0, 32)).map((b) => "0x" + b.toString(16).padStart(2, "0")).join(", ")}]`,
    );

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
    let readout;
    if (cardType === "SI5") {
      readout = parseSI5CardData(this.pendingBlocks);
    } else if (isLargeCardType(cardType)) {
      readout = parseSI10CardData(this.pendingBlocks);
    } else {
      readout = parseSI8CardData(this.pendingBlocks);
    }

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

  // ── Station programming ──────────────────────────────────

  /** Pending command response resolver for request/response flow */
  private commandResolver: {
    cmd: number;
    resolve: (frame: SIParsedFrame) => void;
    reject: (err: Error) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  } | null = null;

  /** Send a command and wait for a specific response command byte */
  private async sendAndWait(
    data: Uint8Array,
    expectedCmd: number,
    timeoutMs = 3000,
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

      this.commandResolver = { cmd: expectedCmd, resolve, reject, timeoutId };
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
          console.log(`[SI] Retry ${attempt}/${retries}`);
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
      clearTimeout(this.commandResolver.timeoutId);
      const resolver = this.commandResolver;
      this.commandResolver = null;
      resolver.resolve(frame);
      return true;
    }
    return false;
  }

  /**
   * Wake a sleeping field control by sending probe commands through the
   * coupling coil. Each attempt activates the coil which gradually wakes
   * the control. Returns the SYS_VAL response once the control responds.
   */
  private async wakeAndReadSysVal(): Promise<SIParsedFrame> {
    await this.sendAndWait(buildSetRemoteMode(), CMD.SET_MS);
    this._inRemoteMode = true;
    // Use short timeouts with many retries to mimic the polling pattern
    // that successfully wakes sleeping controls. Each attempt activates the
    // coupling coil; the control typically responds after 3-6 attempts.
    return this.sendAndWaitRetry(
      buildGetSysVal(),
      CMD.GET_SYSTEM_VALUE,
      2000,
      8,
    );
  }

  /**
   * Read the coupled field control's configuration.
   * Uses remote/indirect mode so commands are forwarded from the BSM8
   * USB master station to the coupled field control via the coupling stick.
   */
  async readConnectedStation(): Promise<StationInfo & { rawData: Uint8Array }> {
    const t0 = performance.now();
    const response = await this.wakeAndReadSysVal();
    console.log(`[SI] ${(performance.now() - t0).toFixed(0)}ms GET_SYS_VAL(read)`);
    console.log(`[SI] ${(performance.now() - t0).toFixed(0)}ms GET_SYS_VAL(read)`);
    const info = parseStationInfo(response.data);
    if (!info) throw new Error("Failed to parse station info");

    this.dispatchEvent(
      new CustomEvent("si:station-read", { detail: info }),
    );
    return { ...info, rawData: response.data };
  }

  /**
   * Quick probe for a coupled field control. Returns station info if one is
   * present on the coupling stick, or null if nothing responds (timeout).
   * Uses a short timeout to keep polling responsive.
   */
  async probeConnectedStation(): Promise<(StationInfo & { rawData: Uint8Array }) | null> {
    try {
      // Switch to remote mode
      await this.sendAndWait(buildSetRemoteMode(), CMD.SET_MS, 1500);
      this._inRemoteMode = true;
      // Single attempt with short timeout — no retries
      const response = await this.sendAndWait(
        buildGetSysVal(),
        CMD.GET_SYSTEM_VALUE,
        1500,
      );
      const info = parseStationInfo(response.data);
      if (!info) return null;
      return { ...info, rawData: response.data };
    } catch {
      return null;
    }
  }

  /**
   * Program a field control: set mode, station code, SRR+, AIR+, sync time, erase backup.
   * Assumes remote mode is already active and station has been read (call readConnectedStation first).
   *
   * @param preReadData — raw GET_SYS_VAL response from readConnectedStation, used to
   *   preserve existing feedback bits. Pass this to avoid a redundant remote switch + read.
   */
  async programControl(config: {
    code: number;
    enableSRR: boolean;
    enableAirPlus: boolean;
    awakeHours?: number;
    beep?: boolean;
  }, preReadData?: Uint8Array): Promise<{ batteryVoltage: number; stationInfo: StationInfo; timeDriftMs: number | null }> {
    let currentFeedback: number;
    let stationInfo: StationInfo;

    if (preReadData) {
      // Use pre-read data — skip redundant remote switch + GET_SYS_VAL
      currentFeedback = preReadData[3 + SYSVAL.FEEDBACK];
      stationInfo = parseStationInfo(preReadData)!;
    } else {
      // Fallback: switch to remote and read
      await this.sendAndWait(buildSetRemoteMode(), CMD.SET_MS);
      this._inRemoteMode = true;
      const readResp = await this.sendAndWaitRetry(
        buildGetSysVal(),
        CMD.GET_SYSTEM_VALUE,
      );
      stationInfo = parseStationInfo(readResp.data)!;
      if (!stationInfo) throw new Error("Failed to read station before programming");
      currentFeedback = readResp.data[3 + SYSVAL.FEEDBACK];
    }

    const t0 = performance.now();
    const lap = (label: string) => {
      const ms = (performance.now() - t0).toFixed(0);
      console.log(`[SI] ${ms}ms ${label}`);
    };

    // 0. Ensure competition config bank (PC0) — must be first so subsequent writes target it
    await this.sendAndWait(
      buildSetSysVal(SYSVAL.PROGRAM, 0x30), // ASCII '0' = competition
      CMD.SET_SYSTEM_VALUE,
    );
    lap("SET_SYS_VAL(PROGRAM=competition)");

    // 1. Set operating mode (CONTROL or BC_CONTROL for AIR+)
    const mode = config.enableAirPlus ? STATION_MODE.BC_CONTROL : STATION_MODE.CONTROL;
    await this.sendAndWait(
      buildSetSysVal(SYSVAL.MODE, mode),
      CMD.SET_SYSTEM_VALUE,
    );
    lap("SET_SYS_VAL(mode)");

    // 2. Set station code + feedback in one write (consecutive bytes 0x72, 0x73)
    const { codeByte, feedbackByte } = encodeStationCode(
      config.code,
      currentFeedback,
    );
    await this.sendAndWait(
      buildSetSysVal(SYSVAL.STATION_CODE, codeByte, feedbackByte),
      CMD.SET_SYSTEM_VALUE,
    );
    lap("SET_SYS_VAL(code+feedback)");

    // 3. Set SRR config (bit 0 = SRR enabled)
    const srrByte = config.enableSRR ? 0x01 : 0x00;
    await this.sendAndWait(
      buildSetSysVal(SYSVAL.SRR_CFG, srrByte),
      CMD.SET_SYSTEM_VALUE,
    );
    lap("SET_SYS_VAL(SRR)");

    // 3b. Set auto power-off time (2 bytes big-endian, hours → minutes)
    if (config.awakeHours !== undefined) {
      const autoOffMinutes = config.awakeHours * 60;
      await this.sendAndWait(
        buildSetSysVal(SYSVAL.AUTO_OFF, (autoOffMinutes >> 8) & 0xff, autoOffMinutes & 0xff),
        CMD.SET_SYSTEM_VALUE,
      );
      lap(`SET_SYS_VAL(AUTO_OFF=${autoOffMinutes}min)`);
    }

    // 4. Sync time
    await this.sendAndWait(buildSetTime(new Date()), CMD.SET_TIME);
    lap("SET_TIME");

    // 5. Read station time immediately to get accurate drift measurement
    const beforeTime = Date.now();
    const timeResp = await this.sendAndWait(
      buildCommand(CMD.GET_TIME),
      CMD.GET_TIME,
    );
    const afterTime = Date.now();
    const timeDriftMs = parseTimeDrift(timeResp.data, beforeTime, afterTime);
    lap(`GET_TIME (rtt=${afterTime - beforeTime}ms, drift=${timeDriftMs}ms)`);

    // 6. Erase backup memory
    await this.sendAndWait(buildEraseBackup(), CMD.ERASE_BACKUP);
    lap("ERASE_BACKUP");

    // 7. Beep to confirm (fire-and-forget)
    if (config.beep !== false) {
      await this.write(buildBeep(2));
    }
    lap("done");

    // Use battery voltage from initial read (doesn't change during programming)
    this.dispatchEvent(
      new CustomEvent("si:control-programmed", {
        detail: {
          code: config.code,
          batteryVoltage: stationInfo.batteryVoltage,
          stationInfo,
          timeDriftMs,
        },
      }),
    );

    return {
      batteryVoltage: stationInfo.batteryVoltage,
      stationInfo,
      timeDriftMs,
    };
  }

  /**
   * Read the backup memory from the connected station/control.
   * Returns all punch records stored in the backup.
   */
  async readBackupMemory(): Promise<BackupRecord[]> {
    // Wake + read SYS_VAL (handles sleeping controls via coupling coil)
    const sysResp = await this.wakeAndReadSysVal();
    const info = parseStationInfo(sysResp.data);
    if (!info) throw new Error("Failed to read station info");
    console.log(`[SI] Backup read: station code=${info.stationCode}, serial=${info.serialNo}`);

    // Backup pointer from SYS_VAL is the write position (next free address).
    // After ERASE_BACKUP it resets to 0x100 (data start). Data lives at 0x100..pointer.
    const endAddr = info.backupPointer;
    console.log(
      `[SI] Backup pointer: 0x${endAddr.toString(16)} (~${info.backupCount} records), ` +
      `mem=${info.memSizeKB}KB`,
    );

    if (endAddr <= 0x100) {
      console.log("[SI] Backup pointer at start — no data");
      this.dispatchEvent(
        new CustomEvent("si:backup-read", { detail: { records: [] } }),
      );
      return [];
    }

    const allRecords: BackupRecord[] = [];

    // Backup data starts at address 0x100. Read 0x80 bytes at a time.
    let readAddr = 0x100;

    while (readAddr < endAddr) {
      const count = Math.min(0x80, endAddr - readAddr);
      const adr2 = (readAddr >> 16) & 0xff;
      const adr1 = (readAddr >> 8) & 0xff;
      const adr0 = readAddr & 0xff;

      try {
        const resp = await this.sendAndWait(
          buildGetBackup(adr2, adr1, adr0, count, true),
          CMD.GET_BACKUP,
          5000,
        );

        const records = parseBackupPage(resp.data);
        if (records.length > 0) {
          console.log(`[SI] Backup @0x${readAddr.toString(16)}: ${records.length} records`);
          allRecords.push(...records);
        } else {
          // Empty page — no more data
          console.log(`[SI] Empty page at 0x${readAddr.toString(16)}, stopping`);
          break;
        }
      } catch (err) {
        console.warn(`[SI] Backup read error at 0x${readAddr.toString(16)}:`, err);
        break;
      }

      readAddr += count;
    }

    console.log(`[SI] Backup read complete: ${allRecords.length} records`);

    this.dispatchEvent(
      new CustomEvent("si:backup-read", { detail: { records: allRecords } }),
    );

    return allRecords;
  }

  /**
   * Erase backup memory on the connected station/control.
   * Assumes remote mode is already active (call after readBackupMemory).
   */
  async clearBackupMemory(): Promise<void> {
    // Ensure we're in remote mode
    await this.sendAndWait(buildSetRemoteMode(), CMD.SET_MS);
    this._inRemoteMode = true;
    const resp = await this.sendAndWaitRetry(
      buildEraseBackup(true),
      CMD.ERASE_BACKUP,
      10000, // longer timeout — flash erase can take several seconds
    );
    console.log("[SI] Erase response:", Array.from(resp.data).map((b) => b.toString(16).padStart(2, "0")).join(" "));
    // Wait for erase to complete
    await new Promise((r) => setTimeout(r, 1000));

    // Verify erase by checking if backup pointer was reset.
    // ERASE_BACKUP resets the write pointer to 0x100 (data start) but doesn't
    // necessarily zero the flash — old bytes remain but the pointer says "no data".
    try {
      const sysResp = await this.sendAndWait(
        buildGetSysVal(),
        CMD.GET_SYSTEM_VALUE,
        5000,
      );
      const info = parseStationInfo(sysResp.data);
      if (info) {
        console.log(`[SI] Post-erase backup pointer: 0x${info.backupPointer.toString(16)} (~${info.backupCount} records)`);
        if (info.backupPointer <= 0x100) {
          console.log("[SI] Erase verified: pointer reset to start");
        } else {
          console.warn(`[SI] Erase may have failed: pointer still at 0x${info.backupPointer.toString(16)}`);
        }
      }
    } catch (err) {
      console.warn("[SI] Could not verify erase:", err);
    }
  }

  /**
   * Power off the connected station/control.
   */
  async powerOffStation(): Promise<void> {
    await this.sendAndWait(buildSetRemoteMode(), CMD.SET_MS);
    this._inRemoteMode = true;
    await new Promise((r) => setTimeout(r, 200));
    await this.write(buildOff());
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
}
