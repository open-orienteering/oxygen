/**
 * Track printer USB-mode flashes performed from inside Oxygen.
 *
 * Use case: an operator borrows a printer from another club, flips it from
 * Printer Class to Virtual COM via Oxygen so it works on their kiosk
 * laptops, then needs to remember to flip it back before returning the
 * gear. We persist a small record per printer in localStorage so the
 * Printer Settings dialog can surface "this printer was flashed during a
 * recent session — restore?" warnings.
 *
 * Key choice: USB *serial* is stable across mode flips (PID changes, but
 * the serial doesn't), while VID:PID is not. We key entries by
 * `${vendorId}:${serial}`. If a printer reports a generic serial like
 * "00000000" (the CT-S310II default), we still use it — that just means
 * multiple identically-defaulted units are treated as one. For
 * single-printer setups this is fine.
 */

import type { CitizenUsbMode } from "./receipt-printer/escpos-config.js";

const STORAGE_KEY = "oxygen.printer-flash-history.v1";

export interface PrinterFlashRecord {
  /** USB vendor ID (hex value, e.g. 0x1d90). */
  vendorId: number;
  /** USB serial string as reported by the device. May be "00000000". */
  serial: string;
  /** USB descriptor product name, for display. */
  productName: string | null;
  /** Mode the printer was in *before* the flash (= what to restore to). */
  originalMode: CitizenUsbMode;
  /** Mode the printer is in after the flash. */
  currentMode: CitizenUsbMode;
  /** ISO-8601 timestamp of the most recent flash. */
  flashedAt: string;
}

export interface FlashHistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Build a stable identifier for a printer that survives mode flips.
 * VID:PID can't be used because PID changes between modes; serial does not.
 */
export function printerKey(vendorId: number, serial: string | null): string {
  return `${vendorId.toString(16).padStart(4, "0")}:${serial ?? ""}`;
}

/** Read the entire history map. Returns {} if storage is empty/corrupt. */
export function readHistory(
  storage: FlashHistoryStorage = defaultStorage(),
): Record<string, PrinterFlashRecord> {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, PrinterFlashRecord> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isFlashRecord(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Get the flash record for a specific printer, or null if none exists.
 */
export function getRecord(
  vendorId: number,
  serial: string | null,
  storage: FlashHistoryStorage = defaultStorage(),
): PrinterFlashRecord | null {
  const history = readHistory(storage);
  return history[printerKey(vendorId, serial)] ?? null;
}

/**
 * Record a flash. If the printer was flashed before, the originalMode is
 * preserved (so a flip-then-flip-back round trip leaves us with the right
 * "restore target"). The currentMode is updated to reflect the latest flip.
 */
export function recordFlash(
  args: {
    vendorId: number;
    serial: string | null;
    productName: string | null;
    fromMode: CitizenUsbMode;
    toMode: CitizenUsbMode;
    now?: Date;
  },
  storage: FlashHistoryStorage = defaultStorage(),
): PrinterFlashRecord {
  const key = printerKey(args.vendorId, args.serial);
  const history = readHistory(storage);
  const previous = history[key];

  // If we're flashing back to the original mode, remove the record entirely
  // — the printer is now in its "as borrowed" state and we should stop
  // nagging the operator about restoring it.
  if (previous && args.toMode === previous.originalMode) {
    delete history[key];
    storage.setItem(STORAGE_KEY, JSON.stringify(history));
    return {
      ...previous,
      currentMode: args.toMode,
      flashedAt: (args.now ?? new Date()).toISOString(),
    };
  }

  const record: PrinterFlashRecord = {
    vendorId: args.vendorId,
    serial: args.serial ?? "",
    productName: args.productName,
    originalMode: previous?.originalMode ?? args.fromMode,
    currentMode: args.toMode,
    flashedAt: (args.now ?? new Date()).toISOString(),
  };
  history[key] = record;
  storage.setItem(STORAGE_KEY, JSON.stringify(history));
  return record;
}

/**
 * Forget a printer's flash record without changing its current mode.
 * Use when the operator confirms the printer is in its intended final state.
 */
export function clearRecord(
  vendorId: number,
  serial: string | null,
  storage: FlashHistoryStorage = defaultStorage(),
): void {
  const history = readHistory(storage);
  const key = printerKey(vendorId, serial);
  if (key in history) {
    delete history[key];
    storage.setItem(STORAGE_KEY, JSON.stringify(history));
  }
}

/** Records for printers whose currentMode != originalMode. */
export function pendingRestores(
  storage: FlashHistoryStorage = defaultStorage(),
): PrinterFlashRecord[] {
  return Object.values(readHistory(storage)).filter(
    (r) => r.currentMode !== r.originalMode,
  );
}

function defaultStorage(): FlashHistoryStorage {
  if (typeof localStorage !== "undefined") return localStorage;
  // In environments without localStorage (SSR, non-browser tests), fall
  // back to a no-op so calls don't throw.
  return {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
}

function isFlashRecord(value: unknown): value is PrinterFlashRecord {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.vendorId === "number" &&
    typeof v.serial === "string" &&
    (v.productName === null || typeof v.productName === "string") &&
    (v.originalMode === "virtual-com" || v.originalMode === "printer-class") &&
    (v.currentMode === "virtual-com" || v.currentMode === "printer-class") &&
    typeof v.flashedAt === "string"
  );
}
