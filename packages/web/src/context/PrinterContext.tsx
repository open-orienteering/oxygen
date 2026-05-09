/**
 * PrinterContext — manages receipt printer state for the whole app.
 *
 * Wraps a PrinterDriver (currently WebUSB) and exposes connection state
 * and a print function to child components.
 *
 * Lives at App level so the USB connection persists across page navigations.
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  WebUsbPrinterDriver,
  isWebUsbSupported,
  buildFinishReceipt,
  buildRegistrationReceipt,
  buildFinishReceiptStarRaster,
  buildRegistrationReceiptStarRaster,
  buildStarRasterTestPattern,
  type FinishReceiptData,
  type RegistrationReceiptData,
  type FinishReceiptLabels,
  type RegistrationReceiptLabels,
  type PrinterIdentity,
  type CitizenUsbMode,
} from "../lib/receipt-printer/index.js";
import {
  recordFlash,
  type PrinterFlashRecord,
} from "../lib/printer-flash-history.js";

// ─── Types ───────────────────────────────────────────────────

interface PrinterContextValue {
  /** Whether WebUSB is available in this browser. */
  supported: boolean;
  /** Whether a printer is currently connected. */
  connected: boolean;
  /** Whether a print job is in progress. */
  printing: boolean;
  /** Error message from the last failed operation, if any. */
  lastError: string | null;
  /** Open the WebUSB device picker and connect. */
  connect(): Promise<void>;
  /** Disconnect from the current printer. */
  disconnect(): void;
  /** Print a finish receipt. Throws if not connected or print fails. */
  print(data: FinishReceiptData): Promise<void>;
  /** Print a registration receipt. Throws if not connected or print fails. */
  printRegistration(data: RegistrationReceiptData): Promise<void>;
  /**
   * Identity of the currently connected printer, or null if disconnected.
   * Updated reactively on connect/disconnect.
   */
  identity: PrinterIdentity | null;
  /** True if the connected printer supports two-way commands (memory switch reads). */
  supportsRead: boolean;
  /** Read the printer's current USB mode (CT-S310II). */
  readUsbMode(): Promise<CitizenUsbMode>;
  /** Read all 10 memory switches (CT-S310II). Returns map keyed by switch number. */
  readAllMemorySwitches(): Promise<Record<number, string>>;
  /**
   * Flip the printer's USB mode and persist a record in flash history.
   * Caller is responsible for telling the operator to power-cycle.
   */
  flashUsbMode(targetMode: CitizenUsbMode, currentMode: CitizenUsbMode): Promise<PrinterFlashRecord | null>;
  /** Trigger the printer's built-in self-test print. */
  printSelfTest(): Promise<void>;
}

// ─── Context ─────────────────────────────────────────────────

const PrinterContext = createContext<PrinterContextValue | null>(null);

function useReceiptLabels() {
  const { t } = useTranslation("receipt");
  // Memoize so print/printRegistration callbacks don't re-create every render.
  // `t` is stable from react-i18next (only changes on language switch).
  return useMemo(() => ({
    finish: (): FinishReceiptLabels => ({
      start: t("start"),
      finish: t("finish"),
      splitHeader: t("splitHeader"),
      fin: t("fin"),
      battery: t("battery"),
      position: t("position"),
      competitionInfo: t("competitionInfo"),
      tagline: t("tagline"),
      missing: "--- " + t("missing", { defaultValue: "MISSING" }) + " ---",
    }),
    registration: (): RegistrationReceiptLabels => ({
      registration: t("registration"),
      receipt: t("receipt"),
      name: t("name") + ":",
      club: t("club") + ":",
      class: t("class") + ":",
      siCard: t("siCard") + ":",
      start: t("start") + ":",
      freeStart: t("freeStart"),
      payment: t("payment") + ":",
      amount: t("amount") + ":",
      printed: t("printed"),
      tagline: t("tagline"),
      entryFee: t("entryFee"),
      vatExempt: t("vatExempt"),
      vat: t("vat"),
      total: t("total"),
      friskvardNote: t("friskvardNote"),
      date: t("date") + ":",
      participant: t("participant") + ":",
      entryFeeSubtitle: t("entryFeeSubtitle"),
      paymentMethod: t("paymentMethod"),
      rentalCardFee: t("rentalCardFee"),
    }),
  }), [t]);
}

export function PrinterProvider({ children }: { children: ReactNode }) {
  const supported = isWebUsbSupported();
  // Create driver once so the USB disconnect listener survives connect/disconnect cycles.
  const driverRef = useRef(new WebUsbPrinterDriver());
  const receiptLabels = useReceiptLabels();

  const [connected, setConnected] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<PrinterIdentity | null>(null);
  const [supportsRead, setSupportsRead] = useState(false);

  // Wire events and attempt auto-reconnect to a previously paired printer.
  useEffect(() => {
    const driver = driverRef.current;
    const onConnected = () => {
      setConnected(true);
      setIdentity(driver.getIdentity());
      setSupportsRead(driver.supportsRead);
    };
    const onDisconnected = () => {
      setConnected(false);
      setIdentity(null);
      setSupportsRead(false);
    };
    driver.addEventListener("printer:connected", onConnected);
    driver.addEventListener("printer:disconnected", onDisconnected);
    if (supported) {
      driver.tryAutoConnect().catch(() => {});
    }
    return () => {
      driver.removeEventListener("printer:connected", onConnected);
      driver.removeEventListener("printer:disconnected", onDisconnected);
    };
  }, [supported]);

  const connect = useCallback(async () => {
    setLastError(null);
    try {
      await driverRef.current.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
      throw err;
    }
  }, []);

  const disconnect = useCallback(() => {
    driverRef.current.disconnect();
  }, []);

  const print = useCallback(async (data: FinishReceiptData) => {
    const driver = driverRef.current;
    if (!driver.connected) throw new Error("Printer not connected");
    setLastError(null);
    setPrinting(true);
    try {
      const merged = { ...data, labels: { ...receiptLabels.finish(), ...data.labels } };
      const id = driver.getIdentity();
      const bytes = id?.protocol === "star-raster"
        ? buildFinishReceiptStarRaster(merged)
        : buildFinishReceipt(merged);
      await driver.sendBytes(bytes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
      throw err;
    } finally {
      setPrinting(false);
    }
  }, [receiptLabels]);

  const printRegistration = useCallback(async (data: RegistrationReceiptData) => {
    const driver = driverRef.current;
    if (!driver.connected) throw new Error("Printer not connected");
    setLastError(null);
    setPrinting(true);
    try {
      const merged = { ...data, labels: { ...receiptLabels.registration(), ...data.labels } };
      const id = driver.getIdentity();
      const bytes = id?.protocol === "star-raster"
        ? buildRegistrationReceiptStarRaster(merged)
        : buildRegistrationReceipt(merged);
      await driver.sendBytes(bytes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
      throw err;
    } finally {
      setPrinting(false);
    }
  }, [receiptLabels]);

  const readUsbMode = useCallback(async () => {
    const driver = driverRef.current;
    if (!driver.connected) throw new Error("Printer not connected");
    setLastError(null);
    try {
      return await driver.readUsbMode();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
      throw err;
    }
  }, []);

  const readAllMemorySwitches = useCallback(async () => {
    const driver = driverRef.current;
    if (!driver.connected) throw new Error("Printer not connected");
    setLastError(null);
    try {
      return await driver.readAllMemorySwitches();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
      throw err;
    }
  }, []);

  const flashUsbMode = useCallback(
    async (targetMode: CitizenUsbMode, currentMode: CitizenUsbMode) => {
      const driver = driverRef.current;
      if (!driver.connected) throw new Error("Printer not connected");
      const id = driver.getIdentity();
      if (!id) throw new Error("Printer identity unavailable");
      setLastError(null);
      try {
        await driver.flashUsbMode(targetMode);
        const record = recordFlash({
          vendorId: id.vendorId,
          serial: id.serialNumber,
          productName: id.productName,
          fromMode: currentMode,
          toMode: targetMode,
        });
        return record;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setLastError(msg);
        throw err;
      }
    },
    [],
  );

  const printSelfTest = useCallback(async () => {
    const driver = driverRef.current;
    if (!driver.connected) throw new Error("Printer not connected");
    setLastError(null);
    setPrinting(true);
    try {
      const id = driver.getIdentity();
      if (id?.protocol === "star-raster") {
        // Star raster doesn't have a built-in self-test command. Send a
        // tiny known raster pattern (one black bar + cut) instead — proves
        // the wire format works and the cut is configured correctly.
        await driver.sendBytes(buildStarRasterTestPattern());
      } else {
        await driver.printSelfTest();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
      throw err;
    } finally {
      setPrinting(false);
    }
  }, []);

  return (
    <PrinterContext.Provider
      value={{
        supported,
        connected,
        printing,
        lastError,
        connect,
        disconnect,
        print,
        printRegistration,
        identity,
        supportsRead,
        readUsbMode,
        readAllMemorySwitches,
        flashUsbMode,
        printSelfTest,
      }}
    >
      {children}
    </PrinterContext.Provider>
  );
}

export function usePrinter(): PrinterContextValue {
  const ctx = useContext(PrinterContext);
  if (!ctx) throw new Error("usePrinter must be used within PrinterProvider");
  return ctx;
}
