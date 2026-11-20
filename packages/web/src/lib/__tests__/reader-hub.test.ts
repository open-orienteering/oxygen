import { describe, it, expect, vi } from "vitest";
import { ReaderHub, type ReaderInfo } from "../reader-hub";
import type {
  SIReader,
  SIReaderDeviceInfo,
  SIReaderKind,
  SIReaderStatus,
} from "../si-reader";

/** Minimal in-memory reader that lets a test drive its events. */
class FakeReader extends EventTarget implements SIReader {
  status: SIReaderStatus = "idle";
  info: SIReaderDeviceInfo | null = null;
  disconnect = vi.fn(async () => this.setStatus("idle"));
  forget = vi.fn(async () => {});
  readonly id: string;
  readonly kind: SIReaderKind;
  readonly label: string;
  constructor(id: string, kind: SIReaderKind = "serial", label = id) {
    super();
    this.id = id;
    this.kind = kind;
    this.label = label;
  }
  get supportsStationProgramming() {
    return this.kind === "serial";
  }
  get isConnected() {
    return this.status === "connected" || this.status === "reading";
  }
  setStatus(status: SIReaderStatus) {
    this.status = status;
    this.dispatchEvent(new CustomEvent("si:status", { detail: { status } }));
  }
  emit(type: string, detail: unknown) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

function listen(hub: ReaderHub, type: string) {
  const seen: unknown[] = [];
  hub.addEventListener(type, (e) => seen.push((e as CustomEvent).detail));
  return seen;
}

const readout = {
  cardNumber: 8123456,
  cardType: "SIAC",
  checkTime: null,
  startTime: 36000,
  finishTime: 37000,
  clearTime: null,
  punches: [{ controlCode: 31, time: 36500 }],
  punchCount: 1,
};

describe("ReaderHub aggregate status", () => {
  it("is idle with no readers", () => {
    expect(new ReaderHub().aggregateStatus()).toBe("idle");
  });

  it("prefers reading > connected > connecting > error > idle", () => {
    const hub = new ReaderHub();
    const a = new FakeReader("a");
    const b = new FakeReader("b");
    hub.add(a);
    hub.add(b);
    a.setStatus("error");
    expect(hub.aggregateStatus()).toBe("error");
    b.setStatus("connecting");
    expect(hub.aggregateStatus()).toBe("connecting");
    a.setStatus("connected");
    expect(hub.aggregateStatus()).toBe("connected");
    b.setStatus("reading");
    expect(hub.aggregateStatus()).toBe("reading");
  });

  it("re-dispatches si:status with the aggregate and the source reader", () => {
    const hub = new ReaderHub();
    const a = new FakeReader("a");
    const b = new FakeReader("b");
    hub.add(a);
    hub.add(b);
    a.setStatus("reading");
    const seen = listen(hub, "si:status");
    b.setStatus("error");
    expect(seen).toEqual([
      { status: "reading", readerId: "b", readerStatus: "error" },
    ]);
  });
});

describe("ReaderHub event forwarding", () => {
  it("forwards the readout detail untouched", () => {
    const hub = new ReaderHub();
    const a = new FakeReader("a");
    hub.add(a);
    const seen = listen(hub, "si:card-readout");
    a.emit("si:card-readout", readout);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(readout);
  });

  it("tags detection and removal with the reader id", () => {
    const hub = new ReaderHub();
    const a = new FakeReader("a");
    const b = new FakeReader("b", "ble");
    hub.add(a);
    hub.add(b);
    const detected = listen(hub, "si:card-detected");
    const removed = listen(hub, "si:card-removed");
    b.emit("si:card-detected", { cardNumber: 1, cardType: "SI8" });
    expect(detected).toEqual([{ cardNumber: 1, cardType: "SI8", readerId: "b" }]);
    expect(hub.lastDetectionReaderId).toBe("b");
    a.emit("si:card-removed", {});
    expect(removed).toEqual([{ readerId: "a" }]);
  });

  it("records when each reader last produced a readout", () => {
    const hub = new ReaderHub();
    const a = new FakeReader("a");
    hub.add(a);
    vi.spyOn(Date, "now").mockReturnValue(1234);
    a.emit("si:card-readout", readout);
    vi.restoreAllMocks();
    expect(hub.snapshot()[0].lastCardAt).toBe(1234);
  });

  it("stops forwarding after remove", async () => {
    const hub = new ReaderHub();
    const a = new FakeReader("a");
    hub.add(a);
    const seen = listen(hub, "si:card-readout");
    await hub.remove("a");
    a.emit("si:card-readout", readout);
    expect(seen).toHaveLength(0);
    expect(hub.list()).toHaveLength(0);
    expect(a.disconnect).toHaveBeenCalled();
  });

  it("calls forget when asked to", async () => {
    const hub = new ReaderHub();
    const b = new FakeReader("b", "ble");
    hub.add(b);
    await hub.remove("b", { forget: true });
    expect(b.forget).toHaveBeenCalled();
  });

  it("ignores adding the same reader twice", () => {
    const hub = new ReaderHub();
    const a = new FakeReader("a");
    hub.add(a);
    hub.add(a);
    const seen = listen(hub, "si:card-readout");
    a.emit("si:card-readout", readout);
    expect(hub.list()).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });
});

describe("ReaderHub snapshot and lookup", () => {
  it("lists readers with their info and emits hub:readers-changed", () => {
    const hub = new ReaderHub();
    const changes: ReaderInfo[][] = [];
    hub.addEventListener("hub:readers-changed", (e) =>
      changes.push((e as CustomEvent).detail),
    );
    const a = new FakeReader("a", "serial", "BSM8 #1");
    hub.add(a);
    a.info = { serial: 1, model: "BSM8", mode: "readout" };
    a.emit("si:reader-info", a.info);
    const last = changes.at(-1)!;
    expect(last).toEqual([
      {
        id: "a",
        kind: "serial",
        label: "BSM8 #1",
        status: "idle",
        info: { serial: 1, model: "BSM8", mode: "readout" },
        supportsStationProgramming: true,
        lastCardAt: null,
      },
    ]);
  });

  it("finds the first serial reader", () => {
    const hub = new ReaderHub();
    hub.add(new FakeReader("b", "ble"));
    const s = new FakeReader("s", "serial");
    hub.add(s);
    expect(hub.firstOfKind("serial")).toBe(s);
    expect(hub.firstOfKind("ble")?.id).toBe("b");
    expect(hub.get("s")).toBe(s);
  });

  it("reports the status of one kind", () => {
    const hub = new ReaderHub();
    const b = new FakeReader("b", "ble");
    const s = new FakeReader("s", "serial");
    hub.add(b);
    hub.add(s);
    b.setStatus("reading");
    expect(hub.aggregateStatus("serial")).toBe("idle");
    expect(hub.aggregateStatus("ble")).toBe("reading");
  });
});
