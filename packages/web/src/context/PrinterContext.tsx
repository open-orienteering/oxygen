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
import {
  WebUsbPrinterDriver,
  isWebUsbSupported,
  buildFinishReceipt,
  type FinishReceiptData,
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
}

// ─── Context ─────────────────────────────────────────────────

const PrinterContext = createContext<PrinterContextValue | null>(null);

export function PrinterProvider({ children }: { children: ReactNode }) {
  const supported = isWebUsbSupported();
  // Create driver once so the USB disconnect listener survives connect/disconnect cycles.
  const driverRef = useRef(new WebUsbPrinterDriver());

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
      const bytes = buildFinishReceipt(data);
      await driver.sendBytes(bytes);
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
      value={{ supported, connected, printing, lastError, connect, disconnect, print }}
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
