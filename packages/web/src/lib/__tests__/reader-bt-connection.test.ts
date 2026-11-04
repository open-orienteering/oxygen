import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RBT_MSG,
  RBT_UUID,
  ReaderBtConnection,
  type BleCharacteristicLike,
  type BleDeviceLike,
  type BleGattServerLike,
  type BleServiceLike,
  type BluetoothLike,
} from "../reader-bt";
import type { SICardReadout } from "../si-protocol";
import { SIAC_CARD, SI8_CARD, cardPayload, message, u16, u32 } from "./fixtures/reader-bt";

// ─── Scripted fake Reader BT ───────────────────────────────

class FakeChar extends EventTarget implements BleCharacteristicLike {
  value: DataView | null = null;
  writes: number[][] = [];
  notifying = false;
  /** Reject the next startNotifications (BlueZ right after a page reload) */
  failNextStart = false;
  onWrite: (bytes: Uint8Array) => void = () => {};
  readonly uuid: string;
  private readonly device: FakeDevice;
  constructor(uuid: string, device: FakeDevice) {
    super();
    this.uuid = uuid;
    this.device = device;
  }
  private async gattOp<T>(fn: () => T): Promise<T> {
    // Web Bluetooth rejects a GATT operation while another one is running.
    if (this.device.opInFlight) throw new Error("GATT operation already in progress");
    this.device.opInFlight = true;
    await Promise.resolve();
    this.device.opInFlight = false;
    if (!this.device.gatt.connected) throw new Error("GATT Server is disconnected");
    return fn();
  }
  startNotifications() {
    return this.gattOp(() => {
      if (this.failNextStart) {
        this.failNextStart = false;
        throw Object.assign(new Error("GATT Error Unknown."), { name: "NotSupportedError" });
      }
      this.notifying = true;
      return this;
    });
  }
  writeValueWithResponse(value: Uint8Array) {
    return this.gattOp(() => {
      const bytes = new Uint8Array(value);
      this.writes.push(Array.from(bytes));
      this.device.log.push(`write ${this.uuid.slice(4, 8)} ${Array.from(bytes.slice(0, 2)).join(",")}`);
      queueMicrotask(() => this.onWrite(bytes));
    });
  }
  readValue() {
    return this.gattOp(() => this.value ?? new DataView(new ArrayBuffer(1)));
  }
  notify(bytes: Uint8Array) {
    if (!this.notifying) return;
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }
}

class FakeService implements BleServiceLike {
  private readonly chars: Map<string, FakeChar>;
  constructor(chars: Map<string, FakeChar>) {
    this.chars = chars;
  }
  async getCharacteristic(uuid: string) {
    const c = this.chars.get(uuid);
    if (!c) throw new Error(`No characteristic ${uuid}`);
    return c;
  }
}

class FakeServer implements BleGattServerLike {
  connected = false;
  connectCalls = 0;
  /** asleep: connect() hangs (sleeping reader); "reject": connect() rejects */
  behaviour: "ok" | "asleep" | "reject" = "ok";
  /** Delay per getPrimaryService call (slow BlueZ service discovery) */
  discoveryDelayMs = 0;
  private readonly device: FakeDevice;
  constructor(device: FakeDevice) {
    this.device = device;
  }
  async connect(): Promise<BleGattServerLike> {
    this.connectCalls++;
    if (this.behaviour === "asleep") return new Promise(() => {});
    if (this.behaviour === "reject") throw new Error("Connection failed");
    this.connected = true;
    return this;
  }
  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.device.dispatchEvent(new Event("gattserverdisconnected"));
  }
  async getPrimaryService(uuid: string) {
    if (this.discoveryDelayMs) await new Promise((r) => setTimeout(r, this.discoveryDelayMs));
    const s = this.device.services.get(uuid);
    if (!s) throw new Error(`No service ${uuid}`);
    return s;
  }
}

interface FakeOptions {
  watchAdvertisements?: boolean;
  battery?: boolean;
}

class FakeDevice extends EventTarget implements BleDeviceLike {
  readonly id = "dev-1";
  readonly name = "Reader BT 500123";
  readonly gatt: FakeServer;
  services = new Map<string, FakeService>();
  opInFlight = false;
  log: string[] = [];
  watchAdvertisements?: (o?: { signal?: AbortSignal }) => Promise<void>;
  watching = false;
  forgotten = false;

  readSettings = new FakeChar(RBT_UUID.readSettings, this);
  writeSettings = new FakeChar(RBT_UUID.writeSettings, this);
  cardState = new FakeChar(RBT_UUID.cardState, this);
  cardData = new FakeChar(RBT_UUID.cardData, this);
  battery = new FakeChar(RBT_UUID.batteryLevel, this);

  /** What the reader answers to a 0x1103 request; null = no answer */
  cardResponses: Array<Uint8Array[] | null> = [];

  constructor(opts: FakeOptions = {}) {
    super();
    this.gatt = new FakeServer(this);
    this.services.set(
      RBT_UUID.settingsService,
      new FakeService(
        new Map([
          [RBT_UUID.readSettings, this.readSettings],
          [RBT_UUID.writeSettings, this.writeSettings],
        ]),
      ),
    );
    this.services.set(
      RBT_UUID.cardService,
      new FakeService(
        new Map([
          [RBT_UUID.cardState, this.cardState],
          [RBT_UUID.cardData, this.cardData],
        ]),
      ),
    );
    if (opts.battery !== false) {
      this.services.set(
        RBT_UUID.batteryService,
        new FakeService(new Map([[RBT_UUID.batteryLevel, this.battery]])),
      );
      this.battery.value = new DataView(new Uint8Array([87]).buffer);
    }
    if (opts.watchAdvertisements) {
      this.watchAdvertisements = async (o) => {
        this.watching = true;
        o?.signal?.addEventListener("abort", () => (this.watching = false));
      };
    }

    this.readSettings.onWrite = (bytes) => {
      const id = bytes[0] | (bytes[1] << 8);
      if (id === RBT_MSG.READ_DEVICE_INFO) {
        const sw = Array.from("2.1.0", (c) => c.charCodeAt(0));
        this.readSettings.notify(
          message(RBT_MSG.READ_DEVICE_INFO, [
            ...u32(500123), ...u16(0x00a7), 2, 1,
            ...u16(2025), 9, 30, ...u16(2025), 10, 1,
            ...sw, 0,
          ]),
        );
      } else if (id === RBT_MSG.READ_ALL_SETTINGS) {
        this.readSettings.notify(message(RBT_MSG.READ_ALL_SETTINGS, [...u16(1), 0x05]));
      }
    };
    this.cardData.onWrite = (bytes) => {
      const id = bytes[0] | (bytes[1] << 8);
      if (id !== RBT_MSG.CARD_DATA_COMPLETE) return;
      const next = this.cardResponses.length ? this.cardResponses.shift()! : null;
      for (const n of next ?? []) this.cardData.notify(n);
    };
  }

  insertCard(cardNumber: number) {
    this.cardState.notify(message(RBT_MSG.CARD_STATE_CHANGE, [...u32(cardNumber), 1, ...u16(1)]));
  }
  removeCard(cardNumber: number) {
    this.cardState.notify(message(RBT_MSG.CARD_STATE_CHANGE, [...u32(cardNumber), 0, ...u16(1)]));
  }
  /** Link loss (reader asleep, out of range) */
  drop() {
    this.gatt.connected = false;
    this.dispatchEvent(new Event("gattserverdisconnected"));
  }
  advertise() {
    if (this.watching) this.dispatchEvent(new Event("advertisementreceived"));
  }
  async forget() {
    this.forgotten = true;
  }
  feedback(): number[] {
    return this.cardData.writes
      .filter((w) => (w[0] | (w[1] << 8)) === RBT_MSG.FEEDBACK)
      .map((w) => w[4]);
  }
}

/** Split a message into 0xA101 segments of at most `chunk` payload bytes. */
function segmented(msg: Uint8Array, chunk = 20): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let off = 0; off < msg.length; off += chunk) {
    const part = Array.from(msg.slice(off, off + chunk));
    const first = off === 0;
    const last = off + chunk >= msg.length;
    const payload = first ? [0x01, ...u32(msg.length), ...part] : [last ? 0x02 : 0x00, ...part];
    out.push(message(RBT_MSG.SEGMENT, payload));
  }
  return out;
}

const SIAC_MSG = message(RBT_MSG.CARD_DATA_COMPLETE, cardPayload(SIAC_CARD));
const SI8_MSG = message(RBT_MSG.CARD_DATA_COMPLETE, cardPayload(SI8_CARD));

async function flush(n = 30) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function events(conn: ReaderBtConnection) {
  const log: Array<{ type: string; detail: unknown }> = [];
  for (const type of ["si:status", "si:card-detected", "si:card-readout", "si:card-removed", "si:reader-info"]) {
    conn.addEventListener(type, (e) => log.push({ type, detail: (e as CustomEvent).detail }));
  }
  return log;
}

async function connected(opts: FakeOptions = {}) {
  const device = new FakeDevice(opts);
  const conn = new ReaderBtConnection(device);
  const log = events(conn);
  await conn.connect();
  return { device, conn, log };
}

// ─── Tests ─────────────────────────────────────────────────

describe("ReaderBtConnection.connect", () => {
  it("subscribes, reads device info, settings and battery, then is ready", async () => {
    const { device, conn, log } = await connected();
    expect(conn.status).toBe("reading");
    expect(conn.isConnected).toBe(true);
    expect(conn.id).toBe("ble:dev-1");
    expect(conn.kind).toBe("ble");
    expect(conn.supportsStationProgramming).toBe(false);
    expect(conn.label).toBe("Reader BT 500123");
    expect(device.readSettings.notifying && device.cardState.notifying && device.cardData.notifying).toBe(true);
    expect(device.battery.notifying).toBe(true);
    expect(conn.info).toEqual({
      model: "Reader BT",
      serial: 500123,
      firmware: "2.1.0",
      mode: "readout",
      batteryPercent: 87,
    });
    expect(log.filter((e) => e.type === "si:status").map((e) => (e.detail as { status: string }).status)).toEqual([
      "connecting",
      "reading",
    ]);
    expect(log.some((e) => e.type === "si:reader-info")).toBe(true);
  });

  it("never runs two GATT operations at once", async () => {
    // FakeChar rejects overlapping operations, so a clean connect proves the queue.
    const { device } = await connected();
    expect(device.log).toEqual(["write 0002 14,1", "write 0002 12,1"]);
  });

  it("subscribes card data, then card state, then settings", async () => {
    const d2 = new FakeDevice();
    const seen: string[] = [];
    for (const c of [d2.cardData, d2.cardState, d2.readSettings]) {
      const orig = c.startNotifications.bind(c);
      c.startNotifications = () => {
        seen.push(c.uuid.slice(4, 8));
        return orig();
      };
    }
    await new ReaderBtConnection(d2).connect();
    expect(seen).toEqual(["0013", "0012", "0002"]);
  });

  it("does not re-read device info on a reconnect", async () => {
    const { device, conn } = await connected();
    expect(device.readSettings.writes).toHaveLength(2);
    await conn.disconnect();
    await conn.connect();
    expect(device.readSettings.writes).toHaveLength(2);
    expect(conn.info?.serial).toBe(500123);
    expect(conn.status).toBe("reading");
  });

  it("queues overlapping writes instead of letting the browser reject one", async () => {
    const { device, conn } = await connected();
    device.cardResponses.push([SI8_MSG]);
    device.insertCard(SI8_CARD.cardNumber);
    await conn.setAutosend(false);
    await flush();
    expect(device.writeSettings.writes).toEqual([[0x0f, 0x01, 1, 0, 0]]);
    expect(device.feedback()).toEqual([1]);
  });

  it("works without a battery service", async () => {
    const { conn } = await connected({ battery: false });
    expect(conn.status).toBe("reading");
    expect(conn.info?.batteryPercent).toBeUndefined();
  });

  it("follows battery notifications", async () => {
    const { device, conn } = await connected();
    device.battery.notify(new Uint8Array([42]));
    expect(conn.info?.batteryPercent).toBe(42);
  });

  it("goes to error and rethrows when GATT connect fails", async () => {
    const device = new FakeDevice();
    device.gatt.behaviour = "reject";
    const conn = new ReaderBtConnection(device);
    await expect(conn.connect()).rejects.toThrow("Connection failed");
    expect(conn.status).toBe("error");
  });
});

describe("card flow (pull)", () => {
  it("detects, requests 0x1103, writes Feedback OK before emitting the readout", async () => {
    const { device, conn, log } = await connected();
    device.cardResponses.push(segmented(SIAC_MSG));

    let feedbackAtReadout: number[] | null = null;
    conn.addEventListener("si:card-readout", () => (feedbackAtReadout = device.feedback()));

    device.insertCard(SIAC_CARD.cardNumber);
    await flush();

    const detected = log.find((e) => e.type === "si:card-detected");
    expect(detected?.detail).toEqual({ cardNumber: 8007045, cardType: "SIAC" });
    const requests = device.cardData.writes.filter((w) => (w[0] | (w[1] << 8)) === RBT_MSG.CARD_DATA_COMPLETE);
    expect(requests).toEqual([[0x03, 0x11, 0, 0]]);
    expect(feedbackAtReadout).toEqual([1]);

    const readout = log.find((e) => e.type === "si:card-readout")?.detail as SICardReadout;
    expect(readout.cardNumber).toBe(8007045);
    expect(readout.cardType).toBe("SIAC");
    expect(readout.punches.map((p) => p.controlCode)).toEqual([101, 102]);
    expect(readout.ownerData?.firstName).toBe("Åsa");
    expect(readout.batteryVoltage).toBeCloseTo(3.05);
  });

  it("emits si:card-removed when the card is taken out", async () => {
    const { device, log } = await connected();
    device.cardResponses.push([SI8_MSG]);
    device.insertCard(SI8_CARD.cardNumber);
    await flush();
    device.removeCard(SI8_CARD.cardNumber);
    expect(log.filter((e) => e.type === "si:card-removed")).toHaveLength(1);
  });

  it("ignores a repeated insert of the card being read out", async () => {
    const { device } = await connected();
    device.cardResponses.push(null);
    device.insertCard(SI8_CARD.cardNumber);
    device.insertCard(SI8_CARD.cardNumber);
    await flush();
    const requests = device.cardData.writes.filter((w) => (w[0] | (w[1] << 8)) === RBT_MSG.CARD_DATA_COMPLETE);
    expect(requests).toHaveLength(1);
  });

  it("retries a bad readout once, then writes Feedback error", async () => {
    const { device, log } = await connected();
    const bad = message(RBT_MSG.CARD_DATA_COMPLETE, [1, 2, 3]);
    device.cardResponses.push([bad], [bad]);
    device.insertCard(SI8_CARD.cardNumber);
    await flush(60);
    expect(device.feedback()).toEqual([2]);
    expect(log.some((e) => e.type === "si:card-readout")).toBe(false);
  });

  it("succeeds on the retry after a decode error", async () => {
    const { device, log } = await connected();
    device.cardResponses.push([message(RBT_MSG.CARD_DATA_COMPLETE, [1, 2, 3])], [SI8_MSG]);
    device.insertCard(SI8_CARD.cardNumber);
    await flush(60);
    expect(device.feedback()).toEqual([1]);
    expect(log.filter((e) => e.type === "si:card-readout")).toHaveLength(1);
  });

  it("handles an unsolicited readout (AUTOSEND on) with a synthesised detection", async () => {
    const { device, log } = await connected();
    device.cardData.notify(SI8_MSG);
    await flush();
    expect(log.find((e) => e.type === "si:card-detected")?.detail).toEqual({
      cardNumber: SI8_CARD.cardNumber,
      cardType: "SI8",
    });
    expect(device.feedback()).toEqual([1]);
    expect(log.filter((e) => e.type === "si:card-readout")).toHaveLength(1);
  });

  describe("with fake timers", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("retries once on timeout, then writes Feedback error", async () => {
      const { device, log } = await connected();
      device.cardResponses.push(null, null);
      device.insertCard(SI8_CARD.cardNumber);
      await vi.advanceTimersByTimeAsync(3000);
      expect(device.feedback()).toEqual([]);
      await vi.advanceTimersByTimeAsync(3000);
      expect(device.feedback()).toEqual([2]);
      const requests = device.cardData.writes.filter((w) => (w[0] | (w[1] << 8)) === RBT_MSG.CARD_DATA_COMPLETE);
      expect(requests).toHaveLength(2);
      expect(log.some((e) => e.type === "si:card-readout")).toBe(false);
    });
  });
});

describe("reconnect", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const statuses = (log: Array<{ type: string; detail: unknown }>) =>
    log.filter((e) => e.type === "si:status").map((e) => (e.detail as { status: string }).status);

  it("reconnects with timed gatt.connect() attempts after a drop", async () => {
    const { device, conn, log } = await connected();
    device.gatt.behaviour = "reject";
    device.drop();
    expect(conn.status).toBe("error");
    expect(conn.isReconnecting).toBe(true);

    await vi.advanceTimersByTimeAsync(0); // direct attempt fails
    expect(device.gatt.connectCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(1000); // timed attempt 1 fails
    expect(device.gatt.connectCalls).toBe(3);
    device.gatt.behaviour = "ok";
    await vi.advanceTimersByTimeAsync(2000); // timed attempt 2 succeeds
    expect(device.gatt.connectCalls).toBe(4);
    expect(conn.status).toBe("reading");
    expect(conn.isReconnecting).toBe(false);
    expect(statuses(log)).toContain("error");

    // Card flow works again on the new connection.
    device.cardResponses.push([SI8_MSG]);
    device.insertCard(SI8_CARD.cardNumber);
    await vi.advanceTimersByTimeAsync(0);
    expect(log.filter((e) => e.type === "si:card-readout")).toHaveLength(1);
  });

  it("abandons a hanging gatt.connect() after 8 s and keeps trying", async () => {
    const { device, conn } = await connected();
    device.gatt.behaviour = "asleep";
    device.drop();
    await vi.advanceTimersByTimeAsync(5000); // direct attempt abandoned after 5 s
    expect(device.gatt.connectCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(1000 + 8000); // timed attempt abandoned after 8 s
    expect(conn.status).toBe("error");
    expect(device.gatt.connectCalls).toBe(3);
    device.gatt.behaviour = "ok";
    await vi.advanceTimersByTimeAsync(2000);
    expect(conn.status).toBe("reading");
  });

  it("does not abandon a reconnect whose service discovery is slow", async () => {
    // Linux/BlueZ: GATT connect is quick, discovery took several seconds.
    const { device, conn } = await connected({ watchAdvertisements: true });
    device.drop();
    device.gatt.discoveryDelayMs = 6000; // 3 services → 18 s, past the connect cap
    await vi.advanceTimersByTimeAsync(1000);
    device.advertise();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(conn.status).toBe("reading");
    expect(device.gatt.connectCalls).toBe(2);
  });

  it("keeps polling until the reader is back, slower after five minutes", async () => {
    const { device, conn } = await connected();
    device.gatt.behaviour = "reject";
    device.drop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(conn.status).toBe("error");
    expect(conn.isReconnecting).toBe(true);
    expect(device.gatt.connectCalls).toBeGreaterThan(25); // ~every 2 s
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const atSlowdown = device.gatt.connectCalls;
    await vi.advanceTimersByTimeAsync(60_000);
    const slowCalls = device.gatt.connectCalls - atSlowdown;
    expect(slowCalls).toBeGreaterThanOrEqual(5); // ~every 10 s
    expect(slowCalls).toBeLessThanOrEqual(7);
    device.gatt.behaviour = "ok"; // a card, twenty minutes later
    await vi.advanceTimersByTimeAsync(10_000);
    expect(conn.status).toBe("reading");
    expect(conn.isReconnecting).toBe(false);
  });

  it("stops after the window when one is given", async () => {
    const device = new FakeDevice();
    device.gatt.behaviour = "reject";
    const conn = new ReaderBtConnection(device);
    const result = conn.connectWhenAdvertising(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toBe(false);
    expect(conn.status).toBe("idle");
    const calls = device.gatt.connectCalls;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(device.gatt.connectCalls).toBe(calls);
  });

  it("connects straight away when the link is still up (no advertisement needed)", async () => {
    // After a page reload BlueZ may still hold the link; the reader then does not advertise.
    const { device, conn } = await connected({ watchAdvertisements: true });
    device.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(conn.status).toBe("reading");
    expect(device.gatt.connectCalls).toBe(2);
    expect(device.watching).toBe(false);
  });

  it("keeps the link and retries setup when a subscribe fails right after connecting", async () => {
    // Page reload: Chrome is still tearing the old page's subscriptions down.
    const { device, conn } = await connected({ watchAdvertisements: true });
    device.drop();
    device.cardState.failNextStart = true;
    await vi.advanceTimersByTimeAsync(0);
    expect(conn.status).toBe("error");
    expect(device.gatt.connected).toBe(true); // kept for the retry
    device.cardState.failNextStart = true; // still busy
    await vi.advanceTimersByTimeAsync(1500);
    expect(conn.status).toBe("error");
    await vi.advanceTimersByTimeAsync(1500);
    expect(conn.status).toBe("reading");
    expect(device.watching).toBe(false); // never needed the scan
  });

  it("gives the link up after the setup retries and falls back to polling", async () => {
    const { device, conn } = await connected({ watchAdvertisements: true });
    device.drop();
    const alwaysFail = () => (device.cardState.failNextStart = true);
    alwaysFail();
    const orig = device.cardState.startNotifications.bind(device.cardState);
    device.cardState.startNotifications = () => {
      const p = orig();
      alwaysFail();
      return p;
    };
    await vi.advanceTimersByTimeAsync(3 * 1500 + 100);
    expect(device.gatt.connected).toBe(false);
    expect(device.watching).toBe(true);
    expect(conn.status).toBe("error");
  });

  it("connects on the next advertisement when watchAdvertisements is available", async () => {
    const { device, conn } = await connected({ watchAdvertisements: true });
    device.gatt.behaviour = "reject"; // asleep: connects fail at once ("no longer in range")
    device.drop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(device.watching).toBe(true);
    device.gatt.behaviour = "ok";
    device.advertise();
    await vi.advanceTimersByTimeAsync(0);
    expect(conn.status).toBe("reading");
    expect(device.watching).toBe(false);
  });

  it("connects by polling when advertisements never reach the page (Linux Chrome)", async () => {
    const { device, conn } = await connected({ watchAdvertisements: true });
    device.gatt.behaviour = "reject";
    device.drop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(device.watching).toBe(true); // keeps the OS scanning
    expect(conn.status).toBe("error");
    device.gatt.behaviour = "ok"; // a card woke the reader; no advertisement event
    await vi.advanceTimersByTimeAsync(2000);
    expect(conn.status).toBe("reading");
    expect(device.watching).toBe(false);
  });

  it("does not reconnect after a manual disconnect", async () => {
    const { device, conn } = await connected();
    await conn.disconnect();
    expect(conn.status).toBe("idle");
    expect(device.gatt.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(device.gatt.connectCalls).toBe(1);
  });

  it("a manual disconnect stops a running reconnect", async () => {
    const { device, conn } = await connected();
    device.gatt.behaviour = "reject";
    device.drop();
    await vi.advanceTimersByTimeAsync(1000);
    await conn.disconnect();
    const calls = device.gatt.connectCalls;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(device.gatt.connectCalls).toBe(calls);
    expect(conn.status).toBe("idle");
  });

  it("a stale reconnect timeout does not disconnect a newer connect", async () => {
    const { device, conn } = await connected({ watchAdvertisements: true });
    device.gatt.behaviour = "asleep";
    device.drop(); // direct attempt now hangs, its 5 s timer running
    await vi.advanceTimersByTimeAsync(1000);
    device.gatt.behaviour = "ok";
    await conn.connect(); // e.g. the user picks the reader in the picker
    expect(conn.status).toBe("reading");
    const calls = device.gatt.connectCalls;
    let dropped = 0;
    device.addEventListener("gattserverdisconnected", () => dropped++);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(dropped).toBe(0);
    expect(device.gatt.connectCalls).toBe(calls);
    expect(conn.status).toBe("reading");
  });

  it("connectWhenAdvertising waits for the reader, then connects", async () => {
    const device = new FakeDevice({ watchAdvertisements: true });
    device.gatt.behaviour = "reject";
    const conn = new ReaderBtConnection(device);
    const result = conn.connectWhenAdvertising();
    expect(conn.status).toBe("connecting");
    await vi.advanceTimersByTimeAsync(10_000);
    device.gatt.behaviour = "ok";
    device.advertise();
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBe(true);
    expect(conn.status).toBe("reading");
  });

  it("connectWhenAdvertising waits indefinitely by default", async () => {
    const device = new FakeDevice({ watchAdvertisements: true });
    device.gatt.behaviour = "reject";
    const conn = new ReaderBtConnection(device);
    let settled = false;
    void conn.connectWhenAdvertising().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(settled).toBe(false);
    expect(conn.status).toBe("connecting");
    await conn.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(conn.status).toBe("idle");
  });
});

describe("forget and statics", () => {
  it("forget disconnects and revokes the permission", async () => {
    const { device, conn } = await connected();
    await conn.forget();
    expect(conn.status).toBe("idle");
    expect(device.forgotten).toBe(true);
  });

  it("requestDevice filters on the settings service and asks for every service", async () => {
    const requestDevice = vi.fn(async () => new FakeDevice());
    await ReaderBtConnection.requestDevice({ requestDevice } as BluetoothLike);
    expect(requestDevice).toHaveBeenCalledWith({
      filters: [{ services: [RBT_UUID.settingsService] }, { namePrefix: "Reader BT" }],
      optionalServices: [
        RBT_UUID.settingsService,
        RBT_UUID.cardService,
        RBT_UUID.sessionsService,
        RBT_UUID.batteryService,
      ],
    });
  });

  it("rememberedDevices returns granted Reader BTs, or nothing without getDevices", async () => {
    const other = Object.assign(new EventTarget(), { id: "x", name: "Heart rate" }) as BleDeviceLike;
    const reader = new FakeDevice();
    const bt = { requestDevice: vi.fn(), getDevices: async () => [other, reader] } as unknown as BluetoothLike;
    expect(await ReaderBtConnection.rememberedDevices(bt)).toEqual([reader]);
    expect(await ReaderBtConnection.rememberedDevices({ requestDevice: vi.fn() } as unknown as BluetoothLike)).toEqual([]);
  });
});
