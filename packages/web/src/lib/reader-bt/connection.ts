/**
 * SPORTident Reader BT over Web Bluetooth.
 *
 * `ReaderBtConnection` implements `SIReader` (si-reader.ts), so DeviceManager
 * treats it like a USB station: it emits the same `si:*` events with an
 * `SICardReadout` built by `toSICardReadout`. Protocol encoding/decoding lives
 * in protocol.ts; this file owns the GATT plumbing:
 *
 * - every GATT operation (subscribe, write, read) runs through one queue,
 *   because Web Bluetooth rejects concurrent operations on a device;
 * - requests wait for their response message id with a timeout (`sendAndWait`);
 * - card flow (pull): CardStateChange in → `si:card-detected` → request 0x1103
 *   → decode → Feedback OK written → `si:card-readout`. A failed or missing
 *   response is retried once, then Feedback error is written;
 * - after an unexpected disconnect the reader is re-connected for 60 s, by
 *   watching for its advertisements where the browser supports that and by
 *   timed `gatt.connect()` attempts otherwise. A manual `disconnect()`
 *   suppresses this.
 *
 * See docs/si-protocol/reader-bt.md for the protocol and
 * docs/registration-and-readout.md §1a for how readers are managed.
 */

import { getCardType, type SICardReadout } from "../si-protocol";
import type {
  SIReader,
  SIReaderDeviceInfo,
  SIReaderStatus,
} from "../si-reader";
import {
  RBT_MSG,
  RBT_UUID,
  SegmentReassembler,
  decodeAllSettings,
  decodeCardData,
  decodeCardStateChange,
  decodeDeviceInfo,
  encodeCardDataRequest,
  encodeFeedback,
  encodeMessage,
  encodeSetAutosend,
  operatingModeLabel,
  toSICardReadout,
  type RbtMessage,
} from "./protocol";

// ─── Web Bluetooth types ───────────────────────────────────
// Web Bluetooth is not part of the standard TS lib; these are the minimal
// structural types this module needs (the browser objects satisfy them, and
// so do the test fakes).

export interface BleCharacteristicLike extends EventTarget {
  readonly uuid?: string;
  readonly value?: DataView | null;
  startNotifications(): Promise<unknown>;
  writeValueWithResponse(value: Uint8Array): Promise<void>;
  readValue(): Promise<DataView>;
}

export interface BleServiceLike {
  getCharacteristic(uuid: string): Promise<BleCharacteristicLike>;
}

export interface BleGattServerLike {
  readonly connected: boolean;
  connect(): Promise<BleGattServerLike>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<BleServiceLike>;
}

export interface BleDeviceLike extends EventTarget {
  readonly id: string;
  readonly name?: string | null;
  readonly gatt?: BleGattServerLike | null;
  /** Chromium: needs `enable-experimental-web-platform-features` on some platforms */
  watchAdvertisements?(options?: { signal?: AbortSignal }): Promise<void>;
  forget?(): Promise<void>;
}

export interface BleRequestDeviceOptions {
  filters: Array<{ services?: string[]; namePrefix?: string }>;
  optionalServices?: string[];
}

export interface BluetoothLike {
  requestDevice(options: BleRequestDeviceOptions): Promise<BleDeviceLike>;
  getDevices?(): Promise<BleDeviceLike[]>;
  getAvailability?(): Promise<boolean>;
}

export type ReaderBtAvailability = "ok" | "no-adapter" | "unsupported" | "insecure";

// ─── Debug logging ─────────────────────────────────────────
// Enable with: localStorage.setItem("oxygen-si-debug", "1")
const RBT_DEBUG = (() => { try { return localStorage.getItem("oxygen-si-debug") === "1"; } catch { return false; } })();
function rbtLog(...args: unknown[]) { if (RBT_DEBUG) console.log("[ReaderBT]", ...args); }
function rbtWarn(...args: unknown[]) { console.warn("[ReaderBT]", ...args); }

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");

// ─── Timing ────────────────────────────────────────────────

/** Response timeout for settings requests and card readouts */
const RESPONSE_TIMEOUT_MS = 3000;
/** How long to keep trying after an unexpected disconnect */
export const RECONNECT_WINDOW_MS = 60_000;
/** A `gatt.connect()` to a sleeping reader may hang; give up on it after this */
const CONNECT_ATTEMPT_TIMEOUT_MS = 8000;
/** Pause before each timed reconnect attempt (last value repeats) */
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000];

const NAME_PREFIX = "Reader BT";

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

interface Waiter {
  resolve: (msg: RbtMessage) => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

function bluetooth(): BluetoothLike | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { bluetooth?: BluetoothLike }).bluetooth;
}

// ─── Connection class ──────────────────────────────────────

export class ReaderBtConnection extends EventTarget implements SIReader {
  readonly kind = "ble" as const;
  readonly supportsStationProgramming = false;
  readonly id: string;
  readonly device: BleDeviceLike;

  private _status: SIReaderStatus = "idle";
  private _info: SIReaderDeviceInfo | null = null;

  private server: BleGattServerLike | null = null;
  private readSettings: BleCharacteristicLike | null = null;
  private writeSettings: BleCharacteristicLike | null = null;
  private cardState: BleCharacteristicLike | null = null;
  private cardData: BleCharacteristicLike | null = null;
  private battery: BleCharacteristicLike | null = null;
  private unsubscribe: Array<() => void> = [];

  private opChain: Promise<unknown> = Promise.resolve();
  private waiters = new Map<number, Waiter>();
  /** Card being read out; guards against a second request for the same insert */
  private pendingCard: number | null = null;

  private manualDisconnect = false;
  /** Bumped by disconnect() and by an abandoned connect attempt; a stale open() gives up. */
  private openGen = 0;
  private reconnect: { abort: AbortController; timer: ReturnType<typeof setTimeout> | null } | null = null;

  constructor(device: BleDeviceLike) {
    super();
    this.device = device;
    this.id = `ble:${device.id}`;
    device.addEventListener("gattserverdisconnected", () => this.onGattDisconnected());
  }

  // ── Static helpers ─────────────────────────────────────

  /** Web Bluetooth exists and the page is a secure context. */
  static isSupported(): boolean {
    return typeof isSecureContext !== "undefined" && isSecureContext && !!bluetooth();
  }

  /** Why the Bluetooth button may be unusable, for the reader dialog. */
  static async availability(): Promise<ReaderBtAvailability> {
    if (typeof isSecureContext !== "undefined" && !isSecureContext) return "insecure";
    const bt = bluetooth();
    if (!bt) return "unsupported";
    if (!bt.getAvailability) return "ok";
    try {
      return (await bt.getAvailability()) ? "ok" : "no-adapter";
    } catch {
      return "ok";
    }
  }

  /** Open the browser's Bluetooth picker. Call from a user gesture. */
  static async requestDevice(bt: BluetoothLike | undefined = bluetooth()): Promise<BleDeviceLike> {
    if (!bt) throw new Error("Web Bluetooth is not supported in this browser");
    return bt.requestDevice({
      filters: [{ services: [RBT_UUID.settingsService] }, { namePrefix: NAME_PREFIX }],
      optionalServices: [
        RBT_UUID.settingsService,
        RBT_UUID.cardService,
        RBT_UUID.sessionsService,
        RBT_UUID.batteryService,
      ],
    });
  }

  /** Reader BTs this origin was granted before (empty where `getDevices` is missing). */
  static async rememberedDevices(bt: BluetoothLike | undefined = bluetooth()): Promise<BleDeviceLike[]> {
    if (!bt?.getDevices) return [];
    try {
      const devices = await bt.getDevices();
      return devices.filter((d) => !d.name || d.name.startsWith(NAME_PREFIX));
    } catch {
      return [];
    }
  }

  // ── SIReader ───────────────────────────────────────────

  get status(): SIReaderStatus {
    return this._status;
  }

  get isConnected(): boolean {
    return this._status === "connected" || this._status === "reading";
  }

  get info(): SIReaderDeviceInfo | null {
    return this._info;
  }

  get label(): string {
    if (this.device.name) return this.device.name;
    if (this._info?.serial) return `${NAME_PREFIX} ${this._info.serial}`;
    return NAME_PREFIX;
  }

  /** True while the 60 s reconnect window (or connectWhenAdvertising) runs. */
  get isReconnecting(): boolean {
    return this.reconnect !== null;
  }

  /**
   * Connect now: GATT connect, discover, subscribe, then read device info,
   * settings and battery. Resolves with the reader ready for cards.
   */
  async connect(): Promise<void> {
    this.manualDisconnect = false;
    this.stopReconnect();
    this.setStatus("connecting");
    try {
      await this.open();
    } catch (err) {
      this.setStatus("error");
      throw err;
    }
  }

  /**
   * Connect as soon as the reader advertises (a card is inserted, or the
   * Service/OFF card wakes it), for up to `windowMs`. Used for readers
   * remembered from an earlier visit and by the dialog's Reconnect button.
   * Resolves true once connected, false when the window ran out.
   */
  connectWhenAdvertising(windowMs = RECONNECT_WINDOW_MS): Promise<boolean> {
    this.manualDisconnect = false;
    this.setStatus("connecting");
    return this.startReconnect(windowMs, "connecting");
  }

  async disconnect(): Promise<void> {
    this.manualDisconnect = true;
    this.openGen++;
    this.stopReconnect();
    this.teardown(new Error("Disconnected"));
    try {
      this.server?.disconnect();
    } catch {
      /* already gone */
    }
    this.server = null;
    this.setStatus("idle");
  }

  /** Disconnect and revoke this origin's permission for the device. */
  async forget(): Promise<void> {
    await this.disconnect();
    await this.device.forget?.();
  }

  /** Per-connection AUTOSEND (firmware ≥ 2.0.0). Oxygen uses pull mode by default. */
  async setAutosend(enabled: boolean): Promise<void> {
    if (!this.writeSettings) throw new Error("Reader BT not connected");
    await this.write(this.writeSettings, encodeSetAutosend(enabled));
  }

  /** Put the reader to sleep; it disconnects and stops advertising. */
  async sleep(): Promise<void> {
    if (!this.writeSettings) throw new Error("Reader BT not connected");
    this.manualDisconnect = true;
    await this.write(this.writeSettings, encodeMessage(RBT_MSG.SET_TO_SLEEP));
  }

  // ── Connection internals ───────────────────────────────

  private async open(): Promise<void> {
    const gatt = this.device.gatt;
    if (!gatt) throw new Error("Device has no GATT server");
    rbtLog("connect", this.device.name ?? this.device.id);
    const gen = ++this.openGen;
    const server = await gatt.connect();
    if (gen !== this.openGen) throw new Error("Connect attempt abandoned");
    this.server = server;
    try {
      const settings = await server.getPrimaryService(RBT_UUID.settingsService);
      const card = await server.getPrimaryService(RBT_UUID.cardService);
      this.readSettings = await settings.getCharacteristic(RBT_UUID.readSettings);
      this.writeSettings = await settings.getCharacteristic(RBT_UUID.writeSettings);
      this.cardState = await card.getCharacteristic(RBT_UUID.cardState);
      this.cardData = await card.getCharacteristic(RBT_UUID.cardData);
      try {
        const batt = await server.getPrimaryService(RBT_UUID.batteryService);
        this.battery = await batt.getCharacteristic(RBT_UUID.batteryLevel);
      } catch {
        this.battery = null;
      }

      this.listen(this.readSettings, "settings");
      this.listen(this.cardState, "cardState");
      this.listen(this.cardData, "cardData");
      await this.op(() => this.readSettings!.startNotifications());
      await this.op(() => this.cardState!.startNotifications());
      await this.op(() => this.cardData!.startNotifications());

      const info: SIReaderDeviceInfo = { model: NAME_PREFIX };
      try {
        const msg = await this.sendAndWait(
          this.readSettings,
          encodeMessage(RBT_MSG.READ_DEVICE_INFO),
          RBT_MSG.READ_DEVICE_INFO,
        );
        const d = decodeDeviceInfo(msg.payload);
        info.serial = d.serialNumber;
        info.firmware = d.softwareVersion || null;
      } catch (err) {
        rbtWarn("ReadDeviceInfo failed:", err);
      }
      try {
        const msg = await this.sendAndWait(
          this.readSettings,
          encodeMessage(RBT_MSG.READ_ALL_SETTINGS),
          RBT_MSG.READ_ALL_SETTINGS,
        );
        info.mode = operatingModeLabel(decodeAllSettings(msg.payload).operatingMode);
      } catch (err) {
        rbtWarn("ReadAllSettings failed:", err);
      }
      if (this.battery) {
        const batt = this.battery;
        try {
          const v = await this.op(() => batt.readValue());
          info.batteryPercent = v.getUint8(0);
        } catch (err) {
          rbtLog("battery read failed:", err);
        }
        const onBattery = () => {
          const v = batt.value;
          if (!v || v.byteLength < 1) return;
          this.setInfo({ ...(this._info ?? {}), batteryPercent: v.getUint8(0) });
        };
        batt.addEventListener("characteristicvaluechanged", onBattery);
        this.unsubscribe.push(() => batt.removeEventListener("characteristicvaluechanged", onBattery));
        await this.op(() => batt.startNotifications()).catch(() => {});
      }
      if (gen !== this.openGen) throw new Error("Connect attempt abandoned");
      this.setInfo(info);
      rbtLog("ready", info);
      this.setStatus("reading");
    } catch (err) {
      this.teardown(err as Error);
      try {
        server.disconnect();
      } catch {
        /* ignore */
      }
      this.server = null;
      throw err;
    }
  }

  private listen(char: BleCharacteristicLike, name: "settings" | "cardState" | "cardData"): void {
    const reassembler = new SegmentReassembler();
    const handler = () => {
      const value = char.value;
      if (!value) return;
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      rbtLog(`← ${name}`, hex(bytes));
      let msg: RbtMessage | null;
      try {
        msg = reassembler.push(bytes);
      } catch (err) {
        rbtWarn(`${name}: bad notification:`, err);
        if (name === "cardData") this.failWaiters([RBT_MSG.CARD_DATA_COMPLETE, RBT_MSG.CARD_DATA_MINIMAL], err as Error);
        return;
      }
      if (msg) this.onMessage(msg);
    };
    char.addEventListener("characteristicvaluechanged", handler);
    this.unsubscribe.push(() => char.removeEventListener("characteristicvaluechanged", handler));
  }

  private onMessage(msg: RbtMessage): void {
    const waiter = this.waiters.get(msg.id);
    if (waiter) {
      this.waiters.delete(msg.id);
      clearTimeout(waiter.timeoutId);
      waiter.resolve(msg);
      return;
    }
    switch (msg.id) {
      case RBT_MSG.CARD_STATE_CHANGE:
        this.onCardState(msg);
        break;
      case RBT_MSG.CARD_DATA_COMPLETE:
      case RBT_MSG.CARD_DATA_MINIMAL:
        // Unsolicited: AUTOSEND is on, so no CardStateChange came first.
        void this.onUnsolicitedCardData(msg);
        break;
      default:
        rbtLog(`unhandled message 0x${msg.id.toString(16)}`);
    }
  }

  // ── Card flow ──────────────────────────────────────────

  private onCardState(msg: RbtMessage): void {
    let state;
    try {
      state = decodeCardStateChange(msg.payload);
    } catch (err) {
      rbtWarn("bad CardStateChange:", err);
      return;
    }
    if (!state.inserted) {
      rbtLog("card removed", state.cardNumber);
      this.dispatchEvent(new CustomEvent("si:card-removed", { detail: {} }));
      return;
    }
    if (this.pendingCard === state.cardNumber) return;
    this.emitDetected(state.cardNumber);
    void this.readCard(state.cardNumber);
  }

  private emitDetected(cardNumber: number): void {
    rbtLog("card detected", cardNumber);
    this.dispatchEvent(
      new CustomEvent("si:card-detected", {
        detail: { cardNumber, cardType: getCardType(cardNumber) },
      }),
    );
  }

  private async readCard(cardNumber: number): Promise<void> {
    const char = this.cardData;
    if (!char) return;
    this.pendingCard = cardNumber;
    try {
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) rbtLog(`retrying readout of ${cardNumber}`);
        try {
          const msg = await this.sendAndWait(
            char,
            encodeCardDataRequest(true),
            RBT_MSG.CARD_DATA_COMPLETE,
          );
          await this.deliver(msg);
          return;
        } catch (err) {
          lastErr = err;
          if (!this.cardData) return; // disconnected mid-readout
        }
      }
      rbtWarn(`readout of card ${cardNumber} failed:`, lastErr);
      await this.write(char, encodeFeedback(false)).catch(() => {});
    } finally {
      this.pendingCard = null;
    }
  }

  private async onUnsolicitedCardData(msg: RbtMessage): Promise<void> {
    const char = this.cardData;
    if (!char) return;
    let readout: SICardReadout;
    try {
      readout = this.decodeReadout(msg);
    } catch (err) {
      rbtWarn("bad unsolicited card data:", err);
      await this.write(char, encodeFeedback(false)).catch(() => {});
      return;
    }
    this.emitDetected(readout.cardNumber);
    await this.feedbackAndEmit(char, readout);
  }

  /** Decode, then Feedback OK, then the readout event. Throws on a bad message. */
  private async deliver(msg: RbtMessage): Promise<void> {
    const readout = this.decodeReadout(msg);
    await this.feedbackAndEmit(this.cardData!, readout);
  }

  private decodeReadout(msg: RbtMessage): SICardReadout {
    return toSICardReadout(decodeCardData(msg));
  }

  private async feedbackAndEmit(char: BleCharacteristicLike, readout: SICardReadout): Promise<void> {
    // Feedback is the reader's beep, the counterpart of the serial ACK; it
    // goes out as soon as the card decoded, regardless of what the server does.
    await this.write(char, encodeFeedback(true)).catch((err) => rbtWarn("feedback failed:", err));
    rbtLog("readout", readout.cardNumber, readout);
    this.dispatchEvent(new CustomEvent("si:card-readout", { detail: readout }));
  }

  // ── GATT queue / request-response ──────────────────────

  /** Run one GATT operation after every earlier one has settled. */
  private op<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(fn, fn);
    this.opChain = run.catch(() => {});
    return run;
  }

  private write(char: BleCharacteristicLike, bytes: Uint8Array): Promise<void> {
    rbtLog("→", hex(bytes));
    return this.op(() => char.writeValueWithResponse(bytes));
  }

  private sendAndWait(
    char: BleCharacteristicLike,
    bytes: Uint8Array,
    expectedId: number,
    timeoutMs = RESPONSE_TIMEOUT_MS,
  ): Promise<RbtMessage> {
    this.waiters.get(expectedId)?.reject(new Error("Superseded by new request"));
    return new Promise<RbtMessage>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.waiters.get(expectedId)?.timeoutId === timeoutId) this.waiters.delete(expectedId);
        reject(new TimeoutError(`Timeout waiting for 0x${expectedId.toString(16)}`));
      }, timeoutMs);
      this.waiters.set(expectedId, { resolve, reject, timeoutId });
      this.write(char, bytes).catch((err) => {
        clearTimeout(timeoutId);
        if (this.waiters.get(expectedId)?.timeoutId === timeoutId) this.waiters.delete(expectedId);
        reject(err);
      });
    });
  }

  private failWaiters(ids: number[], err: Error): void {
    for (const id of ids) {
      const w = this.waiters.get(id);
      if (!w) continue;
      this.waiters.delete(id);
      clearTimeout(w.timeoutId);
      w.reject(err);
    }
  }

  private teardown(err: Error): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.failWaiters([...this.waiters.keys()], err);
    this.readSettings = this.writeSettings = this.cardState = this.cardData = this.battery = null;
    this.pendingCard = null;
    this.opChain = Promise.resolve();
  }

  // ── Reconnect ──────────────────────────────────────────

  private onGattDisconnected(): void {
    if (this.manualDisconnect) {
      this.setStatus("idle");
      return;
    }
    // A disconnect during open() is handled by open()'s own error path.
    if (this._status !== "reading" && this._status !== "connected") return;
    rbtWarn("connection lost; reconnecting");
    this.teardown(new Error("Reader BT disconnected"));
    this.server = null;
    this.setStatus("error");
    void this.startReconnect(RECONNECT_WINDOW_MS, "error");
  }

  /**
   * Try to get the connection back for `windowMs`. Status stays at
   * `waitingStatus` between attempts and ends at `reading` or `idle`.
   */
  private startReconnect(windowMs: number, waitingStatus: SIReaderStatus): Promise<boolean> {
    this.stopReconnect();
    const abort = new AbortController();
    const state = { abort, timer: null as ReturnType<typeof setTimeout> | null };
    this.reconnect = state;
    const deadline = Date.now() + windowMs;

    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        abort.abort();
        if (state.timer) clearTimeout(state.timer);
        if (this.reconnect === state) this.reconnect = null;
        this.device.removeEventListener("advertisementreceived", onAdvert);
        if (!ok && !this.manualDisconnect && !this.isConnected) {
          rbtLog("gave up reconnecting");
          this.setStatus("idle");
        }
        resolve(ok);
      };
      abort.signal.addEventListener("abort", () => finish(this.isConnected));

      const attempt = async (): Promise<boolean> => {
        if (abort.signal.aborted) return false;
        try {
          await withTimeout(this.open(), CONNECT_ATTEMPT_TIMEOUT_MS, () => {
            this.openGen++;
            try {
              this.device.gatt?.disconnect();
            } catch {
              /* ignore */
            }
          });
          if (abort.signal.aborted) return false;
          finish(true);
          return true;
        } catch (err) {
          rbtLog("reconnect attempt failed:", err);
          if (!abort.signal.aborted) this.setStatus(waitingStatus);
          return false;
        }
      };

      // Window end
      state.timer = setTimeout(() => finish(false), windowMs);

      let connecting = false;
      const onAdvert = async () => {
        if (connecting || done) return;
        connecting = true;
        rbtLog("advertisement received");
        await attempt();
        connecting = false;
      };

      const timedLoop = async () => {
        for (let i = 0; !done; i++) {
          const delay = RECONNECT_BACKOFF_MS[Math.min(i, RECONNECT_BACKOFF_MS.length - 1)];
          if (Date.now() + delay >= deadline) return;
          await sleep(delay, abort.signal);
          if (done || (await attempt())) return;
        }
      };

      if (this.device.watchAdvertisements) {
        this.device.addEventListener("advertisementreceived", onAdvert);
        this.device
          .watchAdvertisements({ signal: abort.signal })
          .then(() => rbtLog("watching advertisements"))
          .catch((err) => {
            if (done) return;
            rbtLog("watchAdvertisements unavailable, polling instead:", err);
            this.device.removeEventListener("advertisementreceived", onAdvert);
            void timedLoop();
          });
      } else {
        void timedLoop();
      }
    });
  }

  private stopReconnect(): void {
    this.reconnect?.abort.abort();
    this.reconnect = null;
  }

  // ── State ──────────────────────────────────────────────

  private setStatus(status: SIReaderStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.dispatchEvent(new CustomEvent("si:status", { detail: { status } }));
  }

  private setInfo(info: SIReaderDeviceInfo): void {
    this._info = info;
    this.dispatchEvent(new CustomEvent("si:reader-info", { detail: info }));
  }
}

// ─── Helpers ───────────────────────────────────────────────

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      onTimeout();
      reject(new TimeoutError(`No connection after ${ms} ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
