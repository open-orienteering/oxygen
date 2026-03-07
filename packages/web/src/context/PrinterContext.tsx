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
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  WebUsbPrinterDriver,
  isWebUsbSupported,
  buildFinishReceipt,
  buildRegistrationReceipt,
  type FinishReceiptData,
  type RegistrationReceiptData,
  type FinishReceiptLabels,
  type RegistrationReceiptLabels,
} from "../lib/receipt-printer/index.js";

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
}

// ─── Context ─────────────────────────────────────────────────

const PrinterContext = createContext<PrinterContextValue | null>(null);

function useReceiptLabels() {
  const { t } = useTranslation("receipt");
  return {
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
    }),
  };
}

export function PrinterProvider({ children }: { children: ReactNode }) {
  const supported = isWebUsbSupported();
  // Create driver once so the USB disconnect listener survives connect/disconnect cycles.
  const driverRef = useRef(new WebUsbPrinterDriver());
  const receiptLabels = useReceiptLabels();

  const [connected, setConnected] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  // Wire events and attempt auto-reconnect to a previously paired printer.
  useEffect(() => {
    const driver = driverRef.current;
    const onConnected = () => setConnected(true);
    const onDisconnected = () => setConnected(false);
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
      const bytes = buildFinishReceipt({ ...data, labels: { ...receiptLabels.finish(), ...data.labels } });
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
      const bytes = buildRegistrationReceipt({ ...data, labels: { ...receiptLabels.registration(), ...data.labels } });
      await driver.sendBytes(bytes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
      throw err;
    } finally {
      setPrinting(false);
    }
  }, [receiptLabels]);

  return (
    <PrinterContext.Provider
      value={{ supported, connected, printing, lastError, connect, disconnect, print, printRegistration }}
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
