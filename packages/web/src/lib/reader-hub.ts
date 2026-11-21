/**
 * Fan-in for several card readers.
 *
 * DeviceManager wires its listeners to one ReaderHub instead of one reader.
 * The hub owns any number of `SIReader`s (USB SI stations, Reader BTs) and
 * re-dispatches their events:
 *
 *   si:card-readout     detail: the reader's SICardReadout, untouched
 *   si:card-detected    detail: { ...SICardDetection, readerId }
 *   si:card-removed     detail: { readerId }
 *   si:status           detail: { status: aggregate, readerId, readerStatus }
 *   hub:readers-changed detail: ReaderInfo[] (on any add/remove/status/info change)
 *
 * `si:status` carries the aggregate under `status` so code written for a
 * single reader keeps working.
 */

import type {
  SIReader,
  SIReaderDeviceInfo,
  SIReaderKind,
  SIReaderStatus,
} from "./si-reader";

export interface ReaderInfo {
  id: string;
  kind: SIReaderKind;
  label: string;
  status: SIReaderStatus;
  info: SIReaderDeviceInfo | null;
  supportsStationProgramming: boolean;
  /** Date.now() of the last readout from this reader, null before the first. */
  lastCardAt: number | null;
}

/** Highest first: one live reader makes the whole hub live. */
const STATUS_RANK: Record<SIReaderStatus, number> = {
  reading: 4,
  connected: 3,
  connecting: 2,
  error: 1,
  idle: 0,
};

export class ReaderHub extends EventTarget {
  private readers = new Map<string, SIReader>();
  private unwire = new Map<string, () => void>();
  private lastCardAt = new Map<string, number>();

  /** Reader that reported the most recent card insert. */
  lastDetectionReaderId: string | null = null;

  add(reader: SIReader): void {
    if (this.readers.has(reader.id)) return;
    this.readers.set(reader.id, reader);

    const onStatus = () => {
      this.dispatchEvent(
        new CustomEvent("si:status", {
          detail: {
            status: this.aggregateStatus(),
            readerId: reader.id,
            readerStatus: reader.status,
          },
        }),
      );
      this.changed();
    };
    const onDetected = (e: Event) => {
      this.lastDetectionReaderId = reader.id;
      this.dispatchEvent(
        new CustomEvent("si:card-detected", {
          detail: { ...(e as CustomEvent).detail, readerId: reader.id },
        }),
      );
    };
    const onRemoved = () => {
      this.dispatchEvent(
        new CustomEvent("si:card-removed", { detail: { readerId: reader.id } }),
      );
    };
    const onReadout = (e: Event) => {
      this.lastCardAt.set(reader.id, Date.now());
      this.dispatchEvent(
        new CustomEvent("si:card-readout", {
          detail: (e as CustomEvent).detail,
        }),
      );
      this.changed();
    };
    const onInfo = () => this.changed();

    reader.addEventListener("si:status", onStatus);
    reader.addEventListener("si:card-detected", onDetected);
    reader.addEventListener("si:card-removed", onRemoved);
    reader.addEventListener("si:card-readout", onReadout);
    reader.addEventListener("si:reader-info", onInfo);
    this.unwire.set(reader.id, () => {
      reader.removeEventListener("si:status", onStatus);
      reader.removeEventListener("si:card-detected", onDetected);
      reader.removeEventListener("si:card-removed", onRemoved);
      reader.removeEventListener("si:card-readout", onReadout);
      reader.removeEventListener("si:reader-info", onInfo);
    });
    this.changed();
  }

  /**
   * Disconnect a reader and stop listening to it. With `forget`, the
   * browser's permission for the device is revoked too (Bluetooth only).
   */
  async remove(id: string, opts: { forget?: boolean } = {}): Promise<void> {
    const reader = this.readers.get(id);
    if (!reader) return;
    this.unwire.get(id)?.();
    this.unwire.delete(id);
    this.readers.delete(id);
    this.lastCardAt.delete(id);
    if (this.lastDetectionReaderId === id) this.lastDetectionReaderId = null;
    try {
      await reader.disconnect();
    } catch {
      /* already gone */
    }
    if (opts.forget && reader.forget) {
      try {
        await reader.forget();
      } catch {
        /* not supported */
      }
    }
    this.dispatchEvent(
      new CustomEvent("si:status", {
        detail: { status: this.aggregateStatus(), readerId: id, readerStatus: "idle" },
      }),
    );
    this.changed();
  }

  get(id: string): SIReader | undefined {
    return this.readers.get(id);
  }

  list(): SIReader[] {
    return [...this.readers.values()];
  }

  firstOfKind(kind: SIReaderKind): SIReader | undefined {
    return this.list().find((r) => r.kind === kind);
  }

  /** Best status across all readers, or across one kind. */
  aggregateStatus(kind?: SIReaderKind): SIReaderStatus {
    let best: SIReaderStatus = "idle";
    for (const r of this.readers.values()) {
      if (kind && r.kind !== kind) continue;
      if (STATUS_RANK[r.status] > STATUS_RANK[best]) best = r.status;
    }
    return best;
  }

  snapshot(): ReaderInfo[] {
    return this.list().map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      status: r.status,
      info: r.info ? { ...r.info } : null,
      supportsStationProgramming: r.supportsStationProgramming,
      lastCardAt: this.lastCardAt.get(r.id) ?? null,
    }));
  }

  private changed(): void {
    this.dispatchEvent(
      new CustomEvent("hub:readers-changed", { detail: this.snapshot() }),
    );
  }
}
