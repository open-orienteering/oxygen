/**
 * Transport-independent card reader contract.
 *
 * Every reader Oxygen can talk to (a USB SI station over Web Serial, a
 * SPORTident Reader BT over Web Bluetooth) implements `SIReader` and emits the
 * same `si:*` events with `SICardReadout` as the common currency, so the
 * readout pipeline in DeviceManager does not care which transport a card came
 * from. `ReaderHub` (reader-hub.ts) fans the events of several readers in.
 *
 * Events every reader dispatches:
 *   si:status        { status: SIReaderStatus }
 *   si:card-detected SICardDetection        (card inserted, readout starting)
 *   si:card-readout  SICardReadout          (full readout, after the reader's feedback)
 *   si:card-removed  {}
 *   si:reader-info   SIReaderDeviceInfo     (serial/firmware/mode/battery learned or changed)
 */

export type SIReaderStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reading"
  | "error";

export type SIReaderKind = "serial" | "ble";

export type SIReaderMode = "readout" | "printout" | "standalone" | "other";

export interface SIReaderDeviceInfo {
  serial?: number | null;
  firmware?: string | null;
  /** Product/hardware name, e.g. "BSM8" or "Reader BT" */
  model?: string | null;
  mode?: SIReaderMode | null;
  /** 0–100; Bluetooth readers only */
  batteryPercent?: number | null;
}

export interface SIReader extends EventTarget {
  /** Stable for the lifetime of the object; unique among connected readers. */
  readonly id: string;
  readonly kind: SIReaderKind;
  readonly label: string;
  readonly status: SIReaderStatus;
  readonly isConnected: boolean;
  readonly info: SIReaderDeviceInfo | null;
  /** Only USB SI stations can be programmed / have their backup read. */
  readonly supportsStationProgramming: boolean;
  disconnect(): Promise<void>;
  /** Revoke the browser's permission for this device (Bluetooth only). */
  forget?(): Promise<void>;
}

/** True for the statuses consumers treat as "a reader is live". */
export function isActiveStatus(status: SIReaderStatus): boolean {
  return status === "connected" || status === "reading";
}
