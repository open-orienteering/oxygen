/**
 * DeviceManager React context.
 *
 * Provides global state for connected SI readers, recent card reads,
 * and integration with the backend (store readout + resolve runner).
 *
 * Lives at the App level so the serial connection persists across
 * competition switches.
 */

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  SIReaderConnection,
  type SIReaderStatus,
} from "../lib/webserial";
import type { SICardReadout, SICardOwnerData } from "../lib/si-protocol";
import { trpc } from "../lib/trpc";
import { KioskChannel, recentCardToKioskMessage } from "../lib/kiosk-channel";

// ─── Types ─────────────────────────────────────────────────

/**
 * The action to take when the user clicks on this card entry:
 * - "readout"  — runner found, has race data → open Card Readout
 * - "register" — card not in DB → open Add Runner dialog
 * - "pre-start" — runner found, card is clean → open Start Station
 */
export type CardAction = "readout" | "register" | "pre-start";

export interface RecentCard {
  id: string;
  cardNumber: number;
  cardType: string;
  timestamp: Date;
  /** Determined action based on DB + card data */
  action: CardAction;
  runnerName?: string;
  className?: string;
  clubName?: string;
  status?: string;
  runningTime?: number;
  /** Whether the card has punch/finish data (runner actually ran) */
  hasRaceData: boolean;
  /** Owner data read from the SI card (SI10/SIAC only) */
  ownerData?: SICardOwnerData | null;
  readout?: SICardReadout;
}

interface DeviceManagerState {
  supported: boolean;
  readerStatus: SIReaderStatus;
  connectReader: () => Promise<void>;
  disconnectReader: () => Promise<void>;
  currentCard: RecentCard | null;
  recentCards: RecentCard[];
  clearRecentCards: () => void;
  isOnCardReadoutPage: boolean;
  setIsOnCardReadoutPage: (v: boolean) => void;
  /** Set the active competition nameId for kiosk BroadcastChannel */
  setCompetitionNameId: (nameId: string | null) => void;
  /** Get the kiosk BroadcastChannel (if active) for sending messages */
  getKioskChannel: () => KioskChannel | null;
  /** Set a card number to watch for re-insert (registration confirmation).
   *  The optional callback fires directly in the same page when the card is detected. */
  setPendingConfirmCardNo: (cardNo: number | null, onConfirm?: () => void) => void;
  /** Last card number detected (fires before full readout completes) */
  lastDetectedCardNo: number | null;
}

const MAX_RECENT = 20;

// ─── Context ───────────────────────────────────────────────

const DeviceManagerContext = createContext<DeviceManagerState | null>(null);

export function useDeviceManager(): DeviceManagerState {
  const ctx = useContext(DeviceManagerContext);
  if (!ctx) throw new Error("useDeviceManager must be used within DeviceManagerProvider");
  return ctx;
}

// ─── Helpers ───────────────────────────────────────────────

/**
 * Does this readout contain actual race data?
 *
 * Only check for control punches — start/finish times are unreliable after
 * card clearing because SI cards retain old times from previous races.
 * The MeOS backend has the authoritative finish/start data from the
 * timing stations.
 */
function hasRaceData(readout: SICardReadout): boolean {
  return readout.punches.length > 0;
}

// ─── Provider ──────────────────────────────────────────────

export function DeviceManagerProvider({ children }: { children: ReactNode }) {
  const supported = SIReaderConnection.isSupported();
  const connectionRef = useRef<SIReaderConnection | null>(null);

  const [readerStatus, setReaderStatus] = useState<SIReaderStatus>("idle");
  const [currentCard, setCurrentCard] = useState<RecentCard | null>(null);
  const [recentCards, setRecentCards] = useState<RecentCard[]>([]);
  const [isOnCardReadoutPage, setIsOnCardReadoutPage] = useState(false);
  const [lastDetectedCardNo, setLastDetectedCardNo] = useState<number | null>(null);

  const [competitionNameId, setCompetitionNameIdState] = useState<string | null>(null);
  const kioskChannelRef = useRef<KioskChannel | null>(null);
  const pendingConfirmCardNoRef = useRef<number | null>(null);
  const pendingConfirmCallbackRef = useRef<(() => void) | null>(null);
  const skipNextKioskBroadcastRef = useRef(false);

  const storeReadout = trpc.cardReadout.storeReadout.useMutation();
  const utils = trpc.useUtils();

  // Manage kiosk BroadcastChannel lifecycle
  const setCompetitionNameId = useCallback((nameId: string | null) => {
    setCompetitionNameIdState(nameId);
    if (kioskChannelRef.current) {
      kioskChannelRef.current.close();
      kioskChannelRef.current = null;
    }
    if (nameId) {
      kioskChannelRef.current = new KioskChannel(nameId);
      // Auto-respond to pings from kiosk
      kioskChannelRef.current.subscribe((msg) => {
        if (msg.type === "kiosk-ping" && msg.from === "kiosk") {
          kioskChannelRef.current?.send({ type: "kiosk-ping", from: "admin" });
        }
      });
    }
  }, []);

  const getConnection = useCallback((): SIReaderConnection => {
    if (!connectionRef.current) {
      connectionRef.current = new SIReaderConnection();
    }
    return connectionRef.current;
  }, []);

  // ── Process a card read ─────────────────────────────────

  const addRecentCard = useCallback(
    async (readout: SICardReadout) => {
      const id = `${readout.cardNumber}-${Date.now()}`;
      const raceData = hasRaceData(readout);

      // Initial entry — before we know if runner is in DB
      const entry: RecentCard = {
        id,
        cardNumber: readout.cardNumber,
        cardType: readout.cardType,
        timestamp: new Date(),
        action: "register", // default until we check DB
        hasRaceData: raceData,
        ownerData: readout.ownerData ?? null,
        readout,
      };

      setCurrentCard(entry);
      setRecentCards((prev) => [entry, ...prev].slice(0, MAX_RECENT));

      // Store card data on the server (non-blocking)
      try {
        await storeReadout.mutateAsync({
          cardNo: readout.cardNumber,
          punches: readout.punches.map((p) => ({
            controlCode: p.controlCode,
            time: p.time,
          })),
          checkTime: readout.checkTime ?? undefined,
          startTime: readout.startTime ?? undefined,
          finishTime: readout.finishTime ?? undefined,
          cardType: readout.cardType,
          batteryVoltage: readout.batteryVoltage ?? undefined,
          ownerData: readout.ownerData
            ? {
                firstName: readout.ownerData.firstName,
                lastName: readout.ownerData.lastName,
                sex: readout.ownerData.sex,
                dateOfBirth: readout.ownerData.dateOfBirth,
                club: readout.ownerData.club,
                phone: readout.ownerData.phone,
                email: readout.ownerData.email,
                country: readout.ownerData.country,
              }
            : undefined,
          metadata: readout.metadata
            ? {
                batteryDate: readout.metadata.batteryDate,
                productionDate: readout.metadata.productionDate,
                hardwareVersion: readout.metadata.hardwareVersion,
                softwareVersion: readout.metadata.softwareVersion,
                clearCount: readout.metadata.clearCount,
              }
            : undefined,
        });
      } catch {
        console.warn("[DeviceManager] Failed to store readout on server");
      }

      // Resolve runner info and determine action
      try {
        const result = await utils.cardReadout.readout.fetch({
          cardNo: readout.cardNumber,
        });

        let action: CardAction;
        let status: string | undefined;

        if (!result.found) {
          // Card not in DB → offer to register a new runner
          action = "register";
        } else {
          // Check if the runner already has a result status in the database
          // (OK, MP, DNF, DQ, OverMaxTime, NoTiming, OutOfCompetition, NotCompeting)
          // DNS (20) and Cancel (21) are NOT result statuses.
          const dbStatus = result.runner.dbStatus;
          const hasDbResult =
            dbStatus > 0 && dbStatus !== 20 && dbStatus !== 21;

          if (raceData || hasDbResult) {
            // Runner found AND (card has race data OR already has result in DB) → readout
            action = "readout";
            status =
              result.timing.status === 1
                ? "OK"
                : result.timing.status === 3
                  ? "MP"
                  : result.timing.status === 4
                    ? "DNF"
                    : result.timing.status === 20
                      ? "DNS"
                      : undefined;
          } else {
            // Runner found but card is clean and no result → pre-start
            action = "pre-start";
          }
        }

        const updated: RecentCard = {
          ...entry,
          action,
          runnerName: result.found ? result.runner.name : undefined,
          className: result.found ? result.runner.className : undefined,
          clubName: result.found ? result.runner.clubName : undefined,
          status,
          runningTime: result.found ? result.timing.runningTime : undefined,
        };

        setCurrentCard(updated);
        setRecentCards((prev) =>
          prev.map((c) => (c.id === id ? updated : c)),
        );

        // Broadcast to kiosk window (paired mode) — unless this readout was
        // from a confirmation re-insert (handled by onCardDetected already)
        if (kioskChannelRef.current && !skipNextKioskBroadcastRef.current) {
          kioskChannelRef.current.send(recentCardToKioskMessage(updated));
        }
        skipNextKioskBroadcastRef.current = false;
      } catch {
        // If the fetch fails, keep the initial entry
        // Still broadcast the initial entry to kiosk
        if (kioskChannelRef.current && !skipNextKioskBroadcastRef.current) {
          kioskChannelRef.current.send(recentCardToKioskMessage(entry));
        }
        skipNextKioskBroadcastRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ── Connect / disconnect ────────────────────────────────

  const connectReader = useCallback(async () => {
    const conn = getConnection();
    await conn.connect();
  }, [getConnection]);

  const disconnectReader = useCallback(async () => {
    const conn = connectionRef.current;
    if (conn) await conn.disconnect();
  }, []);

  const clearRecentCards = useCallback(() => {
    setRecentCards([]);
    setCurrentCard(null);
  }, []);

  // ── Wire up event listeners ─────────────────────────────

  useEffect(() => {
    const conn = getConnection();

    const onStatus = (e: Event) => {
      const status = (e as CustomEvent).detail.status as SIReaderStatus;
      setReaderStatus(status);
    };

    const onCardDetected = (e: Event) => {
      const detection = (e as CustomEvent).detail as { cardNumber: number; cardType: string };
      setLastDetectedCardNo(detection.cardNumber);
      // Broadcast "card-reading" to kiosk so it shows "do not remove" message
      if (kioskChannelRef.current) {
        kioskChannelRef.current.send({
          type: "card-reading",
          cardNumber: detection.cardNumber,
        });
      }
      // Check if this card is a pending registration confirmation
      if (
        pendingConfirmCardNoRef.current != null &&
        pendingConfirmCardNoRef.current === detection.cardNumber
      ) {
        // Send confirmation to kiosk window
        kioskChannelRef.current?.send({
          type: "registration-confirm",
          confirmed: true,
        });
        // Notify RunnerDialog in the same page via direct callback
        pendingConfirmCallbackRef.current?.();
        pendingConfirmCardNoRef.current = null;
        pendingConfirmCallbackRef.current = null;
        // Skip the next kiosk broadcast (the readout from this re-insert)
        skipNextKioskBroadcastRef.current = true;
      }
    };

    const onCardReadout = (e: Event) => {
      const readout = (e as CustomEvent).detail as SICardReadout;
      addRecentCard(readout);
    };

    conn.addEventListener("si:status", onStatus);
    conn.addEventListener("si:card-detected", onCardDetected);
    conn.addEventListener("si:card-readout", onCardReadout);

    if (supported) {
      conn.tryAutoReconnect().catch(() => {});
    }

    return () => {
      conn.removeEventListener("si:status", onStatus);
      conn.removeEventListener("si:card-detected", onCardDetected);
      conn.removeEventListener("si:card-readout", onCardReadout);
    };
  }, [getConnection, addRecentCard, supported]);

  const getKioskChannel = useCallback(() => kioskChannelRef.current, []);

  const setPendingConfirmCardNo = useCallback((cardNo: number | null, onConfirm?: () => void) => {
    pendingConfirmCardNoRef.current = cardNo;
    pendingConfirmCallbackRef.current = onConfirm ?? null;
  }, []);

  const value: DeviceManagerState = {
    supported,
    readerStatus,
    connectReader,
    disconnectReader,
    currentCard,
    recentCards,
    clearRecentCards,
    isOnCardReadoutPage,
    setIsOnCardReadoutPage,
    setCompetitionNameId,
    getKioskChannel,
    setPendingConfirmCardNo,
    lastDetectedCardNo,
  };

  return (
    <DeviceManagerContext.Provider value={value}>
      {children}
    </DeviceManagerContext.Provider>
  );
}
