import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BackupReadIncompleteError,
  SIReaderConnection,
  type SICardReadFailure,
  type SerialPortLike,
} from "../webserial";
import {
  CMD,
  ACK,
  SYSVAL,
  STATION_MODE,
  buildCommand,
  extractFrame,
  type SICardReadout,
  type SIParsedFrame,
} from "../si-protocol";
import {
  READOUT_BACKUP_FIXTURE,
  READOUT_BACKUP_FIXTURE_BASE_ADDR,
} from "./fixtures/readout-backup-pcap";
import { STATION_FRAMES_PCAP } from "./fixtures/station-frames-pcap";

/**
 * Drives SIReaderConnection through a scripted fake serial port: the reader's
 * read loop, frame handling, readout state machine and backup walker run for
 * real; only the port is fake. Card memory comes from the captured readout
 * backup (docs/si-protocol/readout-backup), so the layouts are real ones.
 */

// ─── Fake port ─────────────────────────────────────────────

type Responder = (frame: SIParsedFrame, port: FakeSerialPort) => boolean | void;

class FakeSerialPort implements SerialPortLike {
  writes: Uint8Array[] = [];
  openCount = 0;
  closeCount = 0;
  opened = false;
  /** Runs first for every frame the host writes; return true to stop the default replies. */
  responder: Responder = () => false;

  private stream: ReadableStream<Uint8Array> | null = null;
  private ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  private sink: WritableStream<Uint8Array> | null = null;

  get readable(): ReadableStream<Uint8Array> | null {
    return this.stream;
  }
  get writable(): WritableStream<Uint8Array> {
    return this.sink as WritableStream<Uint8Array>;
  }
  getInfo() {
    return { usbVendorId: 0x10c4, usbProductId: 0x800a };
  }

  async open(): Promise<void> {
    this.opened = true;
    this.openCount++;
    this.stream = this.makeStream();
    this.sink = new WritableStream<Uint8Array>({
      write: (chunk) => {
        const bytes = Uint8Array.from(chunk);
        this.writes.push(bytes);
        const parsed = extractFrame(bytes);
        // The station answers after the write has completed, never inside it.
        if (parsed) setTimeout(() => this.onFrame(parsed.frame), 0);
      },
    });
  }
  async close(): Promise<void> {
    this.opened = false;
    this.closeCount++;
    this.stream = null;
    this.ctrl = null;
  }

  private makeStream(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: (c) => {
        this.ctrl = c;
      },
    });
  }

  // Station side ----------------------------------------------------------

  push(bytes: Uint8Array): void {
    this.ctrl?.enqueue(bytes);
  }
  reply(cmd: number, data: number[] | Uint8Array): void {
    this.push(buildCommand(cmd, Array.from(data), true));
  }
  /** A recoverable stream error: the browser hands out a fresh readable. */
  errorAndRecover(): void {
    this.ctrl?.error(new Error("framing error"));
    this.stream = this.makeStream();
  }
  /** A fatal stream error: readable becomes null (device unplugged). */
  errorFatal(): void {
    this.ctrl?.error(new Error("device lost"));
    this.stream = null;
  }

  // Writes the host made, as parsed commands.
  commands(): Array<{ cmd: number; data: Uint8Array }> {
    return this.writes
      .map((w) => extractFrame(w))
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map((r) => ({ cmd: r.frame.cmd, data: r.frame.data }));
  }
  blockRequests(cmd: number = CMD.SI8_READ): number[] {
    return this.commands()
      .filter((c) => c.cmd === cmd)
      .map((c) => c.data[0]);
  }
  ackCount(): number {
    return this.writes.filter((w) => w.length === 1 && w[0] === ACK).length;
  }

  private onFrame(frame: SIParsedFrame): void {
    if (this.responder(frame, this)) return;
    switch (frame.cmd) {
      case CMD.SET_MS:
        this.reply(CMD.SET_MS, [0x00, 0x7d, frame.data[0]]);
        break;
      case CMD.GET_SYSTEM_VALUE:
        this.reply(CMD.GET_SYSTEM_VALUE, sysValData());
        break;
      case CMD.SET_SYSTEM_VALUE:
        this.reply(CMD.SET_SYSTEM_VALUE, [0x00, 0x7d, frame.data[0]]);
        break;
      default:
        break;
    }
  }
}

/** GET_SYS_VAL reply with extended protocol, handshake and feedback already on (no config writes). */
function sysValData(patch: Record<number, number> = {}): Uint8Array {
  // Real station reply from the capture, with PROTO/FEEDBACK set to what the reader wants.
  const real = extractFrame(STATION_FRAMES_PCAP[1])!.frame.data;
  const data = Uint8Array.from(real);
  data[3 + SYSVAL.PROTO] = 0x05;
  data[3 + SYSVAL.FEEDBACK] = 0x03;
  for (const [off, v] of Object.entries(patch)) data[3 + Number(off)] = v;
  return data;
}

// ─── Card memory from the capture ──────────────────────────

function flash(addr: number, len: number): Uint8Array {
  const start = addr - READOUT_BACKUP_FIXTURE_BASE_ADDR;
  return Uint8Array.from(READOUT_BACKUP_FIXTURE.subarray(start, start + len));
}

/** A card slot cut from the backup flash, as the card itself would deliver it. */
function cardBlocks(addr: number, len: number, patchMarker = true): Uint8Array[] {
  const img = flash(addr, len);
  // The backup overwrites the clear-station field with a marker; a live read has none.
  if (patchMarker) img.fill(0xee, 4, 8);
  const blocks: Uint8Array[] = [];
  for (let i = 0; i < len; i += 128) blocks.push(img.slice(i, i + 128));
  return blocks;
}

const SI8_2220164 = () => cardBlocks(0x1280, 0x100);
const SI8_2164102 = () => cardBlocks(0x100, 0x100);
const SIAC_8007045 = () => cardBlocks(0x600, 0x400);
const SI5_452242 = () => cardBlocks(0xe00, 0x80, false);

/** Serve a card's blocks for 0xEF (SI8 and up) and 0xB1 (SI5) read commands. */
function serveCard(
  port: FakeSerialPort,
  blocks: Uint8Array[],
  opts: {
    /** Override one block's reply; return bytes to push, null to stay silent, undefined for the normal reply. */
    block?: (bn: number, attempt: number) => Uint8Array | null | undefined;
  } = {},
): void {
  const attempts = new Map<number, number>();
  const previous = port.responder;
  port.responder = (frame, p) => {
    if (previous(frame, p)) return true;
    if (frame.cmd === CMD.SI8_READ) {
      const bn = frame.data[0];
      const attempt = (attempts.get(bn) ?? 0) + 1;
      attempts.set(bn, attempt);
      const custom = opts.block?.(bn, attempt);
      if (custom === null) return true;
      if (custom) {
        p.push(custom);
        return true;
      }
      if (blocks[bn]) p.reply(CMD.SI8_READ, [0x00, 0x7d, bn, ...blocks[bn]]);
      return true;
    }
    if (frame.cmd === CMD.SI5_READ) {
      p.reply(CMD.SI5_READ, [0x00, 0x7d, ...blocks[0]]);
      return true;
    }
    return false;
  };
}

function det8(cn: number, series: number): Uint8Array {
  return buildCommand(
    CMD.SI8_DETECTED,
    [0x00, 0x7d, series, (cn >> 16) & 0xff, (cn >> 8) & 0xff, cn & 0xff],
    true,
  );
}
function det5(cn: number): Uint8Array {
  const series = Math.floor(cn / 100000);
  const raw = cn % 100000;
  return buildCommand(CMD.SI5_DETECTED, [0x00, 0x7d, 0x00, series, (raw >> 8) & 0xff, raw & 0xff], true);
}
const removedFrame = () => buildCommand(CMD.CARD_REMOVED, [0x00, 0x7d, 0x00, 0x00, 0x00, 0x00], true);

// ─── Harness ───────────────────────────────────────────────

interface Harness {
  conn: SIReaderConnection;
  port: FakeSerialPort;
  readouts: SICardReadout[];
  failures: SICardReadFailure[];
  events: string[];
  statuses: string[];
}

/** Let the fake station answer: its replies are timers, one hop per write. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(1);
}

async function makeReader(setup?: (port: FakeSerialPort) => void): Promise<Harness> {
  const port = new FakeSerialPort();
  setup?.(port);
  const conn = new SIReaderConnection();
  const h: Harness = { conn, port, readouts: [], failures: [], events: [], statuses: [] };
  conn.addEventListener("si:card-readout", (e) => {
    h.readouts.push((e as CustomEvent<SICardReadout>).detail);
    h.events.push("readout");
  });
  conn.addEventListener("si:card-read-failed", (e) => {
    h.failures.push((e as CustomEvent<SICardReadFailure>).detail);
    h.events.push("read-failed");
  });
  conn.addEventListener("si:card-removed", () => h.events.push("removed"));
  conn.addEventListener("si:status", (e) =>
    h.statuses.push((e as CustomEvent<{ status: string }>).detail.status),
  );
  const attached = conn.attach(port);
  let done = false;
  attached.then(() => (done = true), () => (done = true));
  for (let i = 0; i < 100 && !done; i++) await vi.advanceTimersByTimeAsync(1);
  await attached;
  return h;
}

/** Advance fake time until the promise settles (or `maxMs` pass), then await it. */
async function finish<R>(promise: Promise<R>, maxMs = 20000): Promise<R> {
  let done = false;
  promise.then(() => (done = true), () => (done = true));
  for (let t = 0; t < maxMs && !done; t += 10) await vi.advanceTimersByTimeAsync(10);
  return promise;
}

const T = (h: number, m: number, s: number) => h * 3600 + m * 60 + s;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── Readout (SI-04, SI-05, SI-13) ─────────────────────────

describe("card readout through the serial reader", () => {
  it("attaches without rewriting config when the station is already set up", async () => {
    const h = await makeReader();
    expect(h.conn.status).toBe("reading");
    expect(h.port.commands().some((c) => c.cmd === CMD.SET_SYSTEM_VALUE)).toBe(false);
  });

  it("reads SI8 2220164: owner text skipped, 10 punches, one ACK, blocks 0 and 1", async () => {
    const h = await makeReader((p) => serveCard(p, SI8_2220164()));
    h.port.push(det8(2220164, 0x02));
    await settle();
    expect(h.readouts).toHaveLength(1);
    const r = h.readouts[0];
    expect(r.cardNumber).toBe(2220164);
    expect(r.punches).toEqual(
      [
        [48, T(10, 27, 46)], [56, T(10, 32, 35)], [53, T(10, 41, 21)],
        [41, T(10, 43, 56)], [57, T(10, 50, 50)], [44, T(10, 54, 48)],
        [45, T(10, 57, 26)], [31, T(10, 59, 33)], [32, T(11, 2, 50)],
        [100, T(11, 4, 42)],
      ].map(([controlCode, time]) => ({ controlCode, time })),
    );
    expect(h.port.blockRequests()).toEqual([0, 1]);
    expect(h.port.ackCount()).toBe(1);
    expect(h.failures).toEqual([]);
  });

  it("reads SI8 2164102: counter 27 with five blank records gives 22 punches", async () => {
    const h = await makeReader((p) => serveCard(p, SI8_2164102()));
    h.port.push(det8(2164102, 0x02));
    await settle();
    expect(h.readouts).toHaveLength(1);
    expect(h.readouts[0].punchCount).toBe(27);
    expect(h.readouts[0].punches).toHaveLength(22);
    expect(h.readouts[0].punches[0]).toEqual({ controlCode: 72, time: T(11, 27, 37) });
    expect(h.readouts[0].punches[21]).toEqual({ controlCode: 42, time: T(8, 27, 15) });
    expect(h.port.ackCount()).toBe(1);
  });

  it("reads SIAC 8007045: owner and 18 punches from blocks 0-4, one ACK", async () => {
    const h = await makeReader((p) => serveCard(p, SIAC_8007045()));
    h.port.push(det8(8007045, 0x0f));
    await settle();
    expect(h.readouts).toHaveLength(1);
    const r = h.readouts[0];
    expect(r.punches).toHaveLength(18);
    expect(r.punches[0]).toEqual({ controlCode: 32, time: T(18, 50, 2) });
    expect(r.punches[17]).toEqual({ controlCode: 100, time: T(19, 16, 54) });
    expect(r.ownerData?.lastName).toBe("Kempe");
    expect(h.port.blockRequests()).toEqual([0, 1, 2, 3, 4]);
    expect(h.port.ackCount()).toBe(1);
  });

  it("reads SI5 452242 through the 0xB1 frame (130 bytes)", async () => {
    const h = await makeReader((p) => serveCard(p, SI5_452242()));
    h.port.push(det5(452242));
    await settle();
    expect(h.readouts).toHaveLength(1);
    expect(h.readouts[0].cardNumber).toBe(452242);
    expect(h.readouts[0].punches.map((p) => p.controlCode)).toEqual([
      87, 88, 90, 80, 93, 80, 70, 74, 75, 77,
    ]);
    expect(h.port.blockRequests(CMD.SI5_READ)).toEqual([0]);
    expect(h.port.ackCount()).toBe(1);
  });

  it("reassembles a frame that arrives in two pieces", async () => {
    const blocks = SI8_2220164();
    const h = await makeReader((p) =>
      serveCard(p, blocks, {
        block: (bn) => {
          const frame = buildCommand(CMD.SI8_READ, [0x00, 0x7d, bn, ...blocks[bn]], true);
          h.port.push(frame.slice(0, 50));
          setTimeout(() => h.port.push(frame.slice(50)), 5);
          return null;
        },
      }),
    );
    h.port.push(det8(2220164, 0x02));
    await vi.advanceTimersByTimeAsync(50);
    await settle();
    expect(h.readouts).toHaveLength(1);
    expect(h.readouts[0].punches).toHaveLength(10);
    expect(h.port.ackCount()).toBe(1);
  });

  it("a block with a bad CRC is asked for once more, then the read succeeds", async () => {
    const blocks = SI8_2220164();
    const h = await makeReader((p) =>
      serveCard(p, blocks, {
        block: (bn, attempt) => {
          if (bn !== 1 || attempt > 1) return undefined;
          const bad = buildCommand(CMD.SI8_READ, [0x00, 0x7d, bn, ...blocks[bn]], true);
          bad[40] ^= 0x10;
          return bad;
        },
      }),
    );
    h.port.push(det8(2220164, 0x02));
    await settle();
    expect(h.port.blockRequests()).toEqual([0, 1, 1]);
    expect(h.readouts).toHaveLength(1);
    expect(h.readouts[0].punches).toHaveLength(10);
    expect(h.port.ackCount()).toBe(1);
    expect(h.failures).toEqual([]);
  });

  it("a wrong block number is asked for once more, then the read succeeds", async () => {
    const blocks = SI8_2220164();
    const h = await makeReader((p) =>
      serveCard(p, blocks, {
        block: (bn, attempt) =>
          bn === 1 && attempt === 1
            ? buildCommand(CMD.SI8_READ, [0x00, 0x7d, 5, ...blocks[1]], true)
            : undefined,
      }),
    );
    h.port.push(det8(2220164, 0x02));
    await settle();
    expect(h.port.blockRequests()).toEqual([0, 1, 1]);
    expect(h.readouts).toHaveLength(1);
    expect(h.readouts[0].punches).toHaveLength(10);
  });

  it("a late repeat of a block already taken is ignored", async () => {
    const blocks = SI8_2220164();
    const h = await makeReader((p) =>
      serveCard(p, blocks, {
        block: (bn) => {
          if (bn !== 1) return undefined;
          // Block 0 again, then the real block 1.
          h.port.reply(CMD.SI8_READ, [0x00, 0x7d, 0, ...blocks[0]]);
          return undefined;
        },
      }),
    );
    h.port.push(det8(2220164, 0x02));
    await settle();
    expect(h.port.blockRequests()).toEqual([0, 1]);
    expect(h.readouts).toHaveLength(1);
  });

  it("a block shorter than 131 bytes is dropped, not read as card data", async () => {
    const blocks = SI8_2220164();
    const h = await makeReader((p) =>
      serveCard(p, blocks, {
        block: (bn, attempt) =>
          bn === 1 && attempt === 1
            ? buildCommand(CMD.SI8_READ, [0x00, 0x7d, ...blocks[1]], true) // 130 bytes, no block number
            : undefined,
      }),
    );
    h.port.push(det8(2220164, 0x02));
    await settle();
    expect(h.port.blockRequests()).toEqual([0, 1, 1]);
    expect(h.readouts).toHaveLength(1);
  });

  it("a block that never arrives: one re-request after 2 s, then card-read-failed, no ACK, no readout", async () => {
    const blocks = SI8_2220164();
    const h = await makeReader((p) =>
      serveCard(p, blocks, { block: (bn) => (bn === 1 ? null : undefined) }),
    );
    h.port.push(det8(2220164, 0x02));
    await settle();
    expect(h.port.blockRequests()).toEqual([0, 1]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(h.port.blockRequests()).toEqual([0, 1, 1]);
    expect(h.failures).toEqual([]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(h.failures).toEqual([
      { cardNumber: 2220164, cardType: "SI8", reason: "timeout", blocksReceived: 1, blocksExpected: 2 },
    ]);
    expect(h.readouts).toEqual([]);
    expect(h.port.ackCount()).toBe(0);
    // Nothing is left pending: a later timer does not fire another failure.
    await vi.advanceTimersByTimeAsync(10000);
    expect(h.failures).toHaveLength(1);
  });

  it("a failed read does not block the next card", async () => {
    const blocks = SI8_2220164();
    let silent = true;
    const h = await makeReader((p) =>
      serveCard(p, blocks, { block: (bn) => (silent && bn === 1 ? null : undefined) }),
    );
    h.port.push(det8(2220164, 0x02));
    await vi.advanceTimersByTimeAsync(4100);
    expect(h.failures).toHaveLength(1);
    silent = false;
    h.port.push(det8(2220164, 0x02));
    await settle();
    expect(h.readouts).toHaveLength(1);
    expect(h.port.ackCount()).toBe(1);
  });

  it("a block that stays corrupt fails the read as bad-block", async () => {
    const blocks = SI8_2220164();
    const h = await makeReader((p) =>
      serveCard(p, blocks, {
        block: (bn) => {
          if (bn !== 1) return undefined;
          const bad = buildCommand(CMD.SI8_READ, [0x00, 0x7d, bn, ...blocks[bn]], true);
          bad[40] ^= 0x10;
          return bad;
        },
      }),
    );
    h.port.push(det8(2220164, 0x02));
    await settle();
    expect(h.port.blockRequests()).toEqual([0, 1, 1]);
    expect(h.failures.map((f) => f.reason)).toEqual(["bad-block"]);
    expect(h.readouts).toEqual([]);
    expect(h.port.ackCount()).toBe(0);
  });

  it("a card of a layout that cannot be decoded (tCard) fails the read as parse", async () => {
    const blocks = SI8_2220164();
    blocks[0][24] = 0x06;
    const h = await makeReader((p) => serveCard(p, blocks));
    h.port.push(det8(6123456, 0x06));
    await settle();
    expect(h.failures.map((f) => f.reason)).toEqual(["parse"]);
    expect(h.readouts).toEqual([]);
    expect(h.port.ackCount()).toBe(0);
  });

  it("card removed mid-read: card-read-failed (removed) before card-removed", async () => {
    const blocks = SI8_2220164();
    const h = await makeReader((p) =>
      serveCard(p, blocks, { block: (bn) => (bn === 1 ? null : undefined) }),
    );
    h.port.push(det8(2220164, 0x02));
    await settle();
    h.port.push(removedFrame());
    await settle();
    expect(h.events).toEqual(["read-failed", "removed"]);
    expect(h.failures[0]).toMatchObject({ reason: "removed", blocksReceived: 1, blocksExpected: 2 });
    expect(h.port.ackCount()).toBe(0);
    // The timer was cleared with the read.
    await vi.advanceTimersByTimeAsync(10000);
    expect(h.failures).toHaveLength(1);
  });

  it("card removed after a complete read only reports removal", async () => {
    const h = await makeReader((p) => serveCard(p, SI8_2220164()));
    h.port.push(det8(2220164, 0x02));
    await settle();
    h.port.push(removedFrame());
    await settle();
    expect(h.events).toEqual(["readout", "removed"]);
  });

  it("garbage before a frame does not disturb the read", async () => {
    const h = await makeReader((p) => serveCard(p, SI8_2220164()));
    h.port.push(Uint8Array.of(0x13, 0x37, 0x99));
    h.port.push(det8(2220164, 0x02));
    await settle();
    expect(h.readouts).toHaveLength(1);
  });
});

// ─── Backup walk (SI-06) ───────────────────────────────────

/** Answer GET_BACKUP from the captured flash. */
function serveBackup(
  opts: {
    page?: (addr: number, attempt: number) => Uint8Array | null | undefined;
  } = {},
): (p: FakeSerialPort) => void {
  return (port) => {
    const attempts = new Map<number, number>();
    port.responder = (frame, p) => {
      if (frame.cmd !== CMD.GET_BACKUP) return false;
      const addr = (frame.data[0] << 16) | (frame.data[1] << 8) | frame.data[2];
      const count = frame.data[3];
      const attempt = (attempts.get(addr) ?? 0) + 1;
      attempts.set(addr, attempt);
      const custom = opts.page?.(addr, attempt);
      if (custom === null) return true;
      if (custom) {
        p.push(custom);
        return true;
      }
      p.reply(CMD.GET_BACKUP, [0x00, 0x0f, frame.data[0], frame.data[1], frame.data[2], ...flash(addr, count)]);
      return true;
    };
  };
}

/** SYS_VAL of a readout station whose backup pointer is at `end`. */
function readoutStationSysVal(end: number): Uint8Array {
  return sysValData({
    [SYSVAL.MODE]: STATION_MODE.READOUT,
    [SYSVAL.BACKUP_PTR_HI]: (end >> 24) & 0xff,
    [SYSVAL.BACKUP_PTR_HI + 1]: (end >> 16) & 0xff,
    [SYSVAL.BACKUP_PTR_LO]: (end >> 8) & 0xff,
    [SYSVAL.BACKUP_PTR_LO + 1]: end & 0xff,
  });
}

const BACKUP_END = 0x1380; // 0x1280 slot + 0x100
const ALL_SEVEN = [452242, 2164102, 2220164, 8007045, 8060780, 8408405, 8506707];
const numbersOf = (records: Array<{ card?: { cardNumber: number } }>) =>
  records.map((r) => r.card?.cardNumber ?? 0).sort((a, b) => a - b);

describe("readout-station backup walk", () => {
  it("returns all seven captured cards, with pages placed by address", async () => {
    const h = await makeReader(serveBackup());
    const result = await finish(h.conn.readBackupMemory(readoutStationSysVal(BACKUP_END)));
    expect(result.mode).toBe("readout");
    expect(numbersOf(result.records as never)).toEqual(ALL_SEVEN);
  });

  it("a page that never answers rejects the read and nothing is erased", async () => {
    const h = await makeReader(serveBackup({ page: (addr) => (addr === 0x300 ? null : undefined) }));
    const caught = h.conn.readBackupMemory(readoutStationSysVal(BACKUP_END)).catch((e) => e);
    await vi.advanceTimersByTimeAsync(4 * 1500 + 200);
    const err = await caught;
    expect(err).toBeInstanceOf(BackupReadIncompleteError);
    expect((err as BackupReadIncompleteError).address).toBe(0x300);
    expect(h.port.commands().some((c) => c.cmd === CMD.ERASE_BACKUP)).toBe(false);
  });

  it("a late reply for an earlier page is discarded, not taken for the next page", async () => {
    // Page 0x200 is first answered with the data of page 0x180 (a stale reply).
    const h = await makeReader(
      serveBackup({
        page: (addr, attempt) =>
          addr === 0x200 && attempt === 1
            ? buildCommand(CMD.GET_BACKUP, [0x00, 0x0f, 0x00, 0x01, 0x80, ...flash(0x180, 0x80)], true)
            : undefined,
      }),
    );
    // The stale frame is swallowed and the command keeps waiting; the real
    // reply never comes in this script, so the page is retried after 1.5 s.
    const result = await finish(h.conn.readBackupMemory(readoutStationSysVal(BACKUP_END)));
    expect(numbersOf(result.records as never)).toEqual(ALL_SEVEN);
  });

  it("a reply of the wrong length is retried, then the page is accepted", async () => {
    const h = await makeReader(
      serveBackup({
        page: (addr, attempt) =>
          addr === 0x280 && attempt === 1
            ? buildCommand(CMD.GET_BACKUP, [0x00, 0x0f, 0x00, 0x02, 0x80, ...flash(0x280, 0x40)], true)
            : undefined,
      }),
    );
    const result = await finish(h.conn.readBackupMemory(readoutStationSysVal(BACKUP_END)));
    expect(numbersOf(result.records as never)).toEqual(ALL_SEVEN);
  });
});

// ─── Reader disconnects and recovers (SI-18) ───────────────

describe("serial stream errors and reconnect", () => {
  it("a recoverable stream error ends in 'reading' again and the next card reads", async () => {
    const h = await makeReader((p) => serveCard(p, SI8_2220164()));
    h.port.errorAndRecover();
    await settle();
    expect(h.statuses.slice(-2)).toEqual(["error", "reading"]);
    expect(h.conn.status).toBe("reading");
    h.port.push(det8(2220164, 0x02));
    await settle();
    expect(h.readouts).toHaveLength(1);
  });

  it("a fatal error fails the open read, closes the port and leaves status 'error'", async () => {
    const blocks = SI8_2220164();
    const h = await makeReader((p) =>
      serveCard(p, blocks, { block: (bn) => (bn === 1 ? null : undefined) }),
    );
    h.port.push(det8(2220164, 0x02));
    await settle();
    h.port.errorFatal();
    await settle();
    expect(h.conn.status).toBe("error");
    expect(h.failures.map((f) => f.reason)).toEqual(["removed"]);
    expect(h.port.closeCount).toBe(1);
    expect(h.conn.holdsPort(h.port)).toBe(false);
  });

  it("a fatal error rejects a command that was waiting for its answer", async () => {
    let silent = false;
    const h = await makeReader((p) => {
      p.responder = (f) => silent && f.cmd === CMD.GET_SYSTEM_VALUE;
    });
    silent = true;
    const pending = h.conn.readConnectedStation().catch((e) => e);
    await settle();
    h.port.errorFatal();
    // The wake loop retries a rejected probe, so give it its 10 attempts.
    expect(await finish(pending)).toBeInstanceOf(Error);
  });

  it("after a fatal error, attach(samePort) works again and writes reach the port", async () => {
    const h = await makeReader((p) => serveCard(p, SI8_2220164()));
    h.port.errorFatal();
    await settle();
    expect(h.conn.status).toBe("error");
    const writesBefore = h.port.writes.length;

    const again = h.conn.attach(h.port);
    await settle();
    await again;
    expect(h.port.openCount).toBe(2);
    expect(h.conn.status).toBe("reading");
    expect(h.port.writes.length).toBeGreaterThan(writesBefore);

    h.port.push(det8(2220164, 0x02));
    await settle();
    expect(h.readouts).toHaveLength(1);
  });

  describe("connect() with the picker", () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "serial");
    afterEach(() => {
      if (original) Object.defineProperty(navigator, "serial", original);
      else delete (navigator as unknown as Record<string, unknown>).serial;
    });
    function stubPicker(result: () => Promise<SerialPortLike>) {
      Object.defineProperty(navigator, "serial", {
        configurable: true,
        value: { requestPort: result, getPorts: async () => [] },
      });
    }

    it("a cancelled picker leaves an already connected reader running", async () => {
      const h = await makeReader((p) => serveCard(p, SI8_2220164()));
      stubPicker(() => Promise.reject(Object.assign(new Error("none"), { name: "NotFoundError" })));
      await expect(h.conn.connect()).rejects.toThrow();
      expect(h.conn.status).toBe("reading");
      expect(h.port.closeCount).toBe(0);
      h.port.push(det8(2220164, 0x02));
      await settle();
      expect(h.readouts).toHaveLength(1);
    });

    it("picking another port closes the first one instead of stranding it open", async () => {
      const h = await makeReader();
      const second = new FakeSerialPort();
      stubPicker(async () => second);
      const run = h.conn.connect();
      await settle();
      await run;
      expect(h.port.opened).toBe(false);
      expect(h.port.closeCount).toBe(1);
      expect(second.opened).toBe(true);
      expect(h.conn.holdsPort(second)).toBe(true);
      expect(h.conn.status).toBe("reading");
    });
  });
});
