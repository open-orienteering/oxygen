/**
 * DeviceManager — being re-ported. The full WebSerial / SI card pipeline
 * is staged with the punch-matcher port.
 *
 * This stub provides a placeholder context so callers compile. Hooking
 * it back up to real hardware lands as a follow-up.
 */

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { KioskChannel } from "../lib/kiosk-channel";

export type CardAction = "readout" | "register" | "pre-start";

export interface RecentCard {
  cardNumber: number;
  readAt: number;
  action: CardAction;
}

export type ReaderStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reading"
  | "error";

export interface DeviceManagerContext {
  readers: never[];
  recentCards: RecentCard[];
  currentCard: RecentCard | null;
  isReading: boolean;
  isOnCardReadoutPage: boolean;
  supported: boolean;
  readerStatus: ReaderStatus;
  startReading: () => Promise<void>;
  stopReading: () => Promise<void>;
  connectReader: () => Promise<void>;
  disconnectReader: () => Promise<void>;
  clearRecentCards: () => void;
  setCompetitionNameId: (nameId: string | null) => void;
  getKioskChannel: () => KioskChannel | null;
}

const ctx = createContext<DeviceManagerContext | null>(null);

export function DeviceManagerProvider({ children }: { children: ReactNode }) {
  const value: DeviceManagerContext = useMemo(
    () => ({
      readers: [],
      recentCards: [],
      currentCard: null,
      isReading: false,
      isOnCardReadoutPage: false,
      supported: false,
      readerStatus: "disconnected",
      startReading: async () => {},
      stopReading: async () => {},
      connectReader: async () => {},
      disconnectReader: async () => {},
      clearRecentCards: () => {},
      setCompetitionNameId: () => {},
      getKioskChannel: () => null,
    }),
    [],
  );
  return <ctx.Provider value={value}>{children}</ctx.Provider>;
}

export function useDeviceManager(): DeviceManagerContext {
  const v = useContext(ctx);
  if (!v) {
    throw new Error("useDeviceManager must be used inside DeviceManagerProvider");
  }
  return v;
}
