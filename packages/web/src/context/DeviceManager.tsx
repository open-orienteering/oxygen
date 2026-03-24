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
  /** Whether the action has been resolved from the DB (false = still pending lookup) */
  actionResolved: boolean;
  runnerName?: string;
  className?: string;
  clubName?: string;
  status?: string;
  runningTime?: number;
  /** Whether the card has punch/finish data (runner actually ran) */
  hasRaceData: boolean;
  /** Whether this runner was registered with a rental card */
  isRentalCard?: boolean;
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
  /** @deprecated No longer used — confirmation is now via operator click */
  setPendingConfirmCardNo: (cardNo: number | null, onConfirm?: () => void) => void;
  /** Last card number detected (fires before full readout completes) */
  lastDetectedCardNo: number | null;
  /** Get the raw SIReaderConnection for station programming operations */
  getReaderConnection: () => SIReaderConnection;
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
 * Check if the SI card's punch data is likely from today's competition.
 *
 * Uses the day-of-week encoded in the SI card's PTD bytes for finish/check
 * times. If the finish (or check) was on a different day-of-week than today,
 * the punches are stale data from a previous race.
 *
 * Returns false if card has no punches or if DOW indicates a different day.
 * Returns true if DOW matches today or if no DOW info is available (conservative).
 */
export function isPunchDataFresh(readout: SICardReadout): boolean {
  if (readout.punches.length === 0) return false;

  // Convert JS day (0=Sun..6=Sat) to SI day (1=Mon..7=Sun)
  const jsDay = new Date().getDay();
  const todaySIDow = jsDay === 0 ? 7 : jsDay;
  // Accept yesterday too (night-O events span midnight: Saturday start → Sunday finish)
  const yesterdaySIDow = todaySIDow === 1 ? 7 : todaySIDow - 1;

  // Primary: check finish day-of-week (today or yesterday for night-O)
  if (
    readout.finishDayOfWeek != null &&
    readout.finishDayOfWeek !== todaySIDow &&
    readout.finishDayOfWeek !== yesterdaySIDow
  ) {
    return false;
  }

  // Fallback: check-time DOW (today or yesterday for night-O DNFs)
  if (
    readout.finishDayOfWeek == null &&
    readout.checkDayOfWeek != null &&
    readout.checkDayOfWeek !== todaySIDow &&
    readout.checkDayOfWeek !== yesterdaySIDow
  ) {
    return false;
  }

  return true; // DOW matches or unavailable → assume fresh (server validates further)
}

/**
 * Check if two card readouts have identical punch data.
 * If all punches, start/finish/check times match exactly, the card hasn't changed.
 */
function readoutsMatch(a: SICardReadout, b: SICardReadout): boolean {
  if (a.cardNumber !== b.cardNumber) return false;
  if (a.startTime !== b.startTime) return false;
  if (a.finishTime !== b.finishTime) return false;
  if (a.checkTime !== b.checkTime) return false;
  if (a.punches.length !== b.punches.length) return false;
  for (let i = 0; i < a.punches.length; i++) {
    if (a.punches[i].controlCode !== b.punches[i].controlCode) return false;
    if (a.punches[i].time !== b.punches[i].time) return false;
  }
  return true;
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
  // Legacy refs kept as no-ops for interface compat
  const pendingConfirmCardNoRef = useRef<number | null>(null);
  const pendingConfirmCallbackRef = useRef<(() => void) | null>(null);

  const storeReadout = trpc.cardReadout.storeReadout.useMutation();
  const applyResult = trpc.cardReadout.applyResult.useMutation();
  const utils = trpc.useUtils();

  // TestLab injection BroadcastChannel
  const testLabChannelRef = useRef<BroadcastChannel | null>(null);

  // Manage kiosk BroadcastChannel lifecycle
  const setCompetitionNameId = useCallback((nameId: string | null) => {
    setCompetitionNameIdState(nameId);
    if (kioskChannelRef.current) {
      kioskChannelRef.current.close();
      kioskChannelRef.current = null;
    }
    // Clean up old testlab channel
    if (testLabChannelRef.current) {
      testLabChannelRef.current.close();
      testLabChannelRef.current = null;
    }
    if (nameId) {
      kioskChannelRef.current = new KioskChannel(nameId);
      // Listen for TestLab fake readout injections
      testLabChannelRef.current = new BroadcastChannel(`oxygen-testlab-${nameId}`);
      testLabChannelRef.current.onmessage = (event) => {
        if (event.data?.type === "inject-readout" && event.data.readout) {
          addRecentCard(event.data.readout);
        }
      };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getConnection = useCallback((): SIReaderConnection => {
    if (!connectionRef.current) {
      connectionRef.current = new SIReaderConnection();
    }
    return connectionRef.current;
  }, []);

  // ── Process a card read ─────────────────────────────────

  // Track recent readouts for deduplication (ref to avoid stale closure issues)
  const recentCardsRef = useRef<RecentCard[]>([]);

  const addRecentCard = useCallback(
    async (readout: SICardReadout) => {
      // Deduplicate: if same card with identical punch data already exists,
      // reuse the entry (update timestamp) but still re-resolve action from DB
      // (runner may have been registered since last read).
      const existing = recentCardsRef.current.find(
        (c) => c.readout && readoutsMatch(c.readout, readout),
      );
      const isDuplicate = !!existing;

      const id = isDuplicate ? existing.id : `${readout.cardNumber}-${Date.now()}`;
      const raceData = isPunchDataFresh(readout);

      // Initial entry — before we know if runner is in DB
      const entry: RecentCard = isDuplicate
        ? { ...existing, timestamp: new Date(), ownerData: readout.ownerData ?? existing.ownerData, actionResolved: false }
        : {
            id,
            cardNumber: readout.cardNumber,
            cardType: readout.cardType,
            timestamp: new Date(),
            action: "register", // default until we check DB
            actionResolved: false,
            hasRaceData: raceData,
            ownerData: readout.ownerData ?? null,
            readout,
          };

      setCurrentCard(entry);
      if (isDuplicate) {
        setRecentCards((prev) => {
          const next = [entry, ...prev.filter((c) => c.id !== id)].slice(0, MAX_RECENT);
          recentCardsRef.current = next;
          return next;
        });
      } else {
        setRecentCards((prev) => {
          const next = [entry, ...prev].slice(0, MAX_RECENT);
          recentCardsRef.current = next;
          return next;
        });
      }

      // Store card data on the server (skip if duplicate — already stored)
      let serverPunchesRelevant = true;
      if (!isDuplicate) {
        try {
          const storeResult = await storeReadout.mutateAsync({
            cardNo: readout.cardNumber,
            punches: readout.punches.map((p) => ({
              controlCode: p.controlCode,
              time: p.time,
            })),
            checkTime: readout.checkTime ?? undefined,
            startTime: readout.startTime ?? undefined,
            finishTime: readout.finishTime ?? undefined,
            cardType: readout.cardType,
            punchesFresh: raceData,
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
          serverPunchesRelevant = storeResult.punchesRelevant ?? true;
        } catch {
          console.warn("[DeviceManager] Failed to store readout on server");
        }
      }

      // Invalidate cache to ensure fresh DB data (runner may have been registered
      // since the last read of this card)
      await utils.cardReadout.readout.invalidate({ cardNo: readout.cardNumber });

      // Resolve runner info and determine action (always — even for duplicates)
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

          // Server-side match score (0.0–1.0): how well do the card's
          // punches match the runner's assigned course? Penalized by
          // foreign punches (controls not in this competition).
          const matchScore = result.matchScore ?? 0;
          const punchesRelevant = matchScore >= 0.2;

          if (punchesRelevant || hasDbResult) {
            // Runner found AND (punches match this competition OR already has result in DB) → readout
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
            // Runner found but punches are stale/absent and no result → pre-start
            action = "pre-start";
          }
        }

        const updated: RecentCard = {
          ...entry,
          action,
          actionResolved: true,
          hasRaceData: result.found
            ? ((result.matchScore ?? 0) >= 0.2 && serverPunchesRelevant)
            : entry.hasRaceData,
          runnerName: result.found ? result.runner.name : undefined,
          className: result.found ? result.runner.className : undefined,
          clubName: result.found ? result.runner.clubName : undefined,
          status,
          runningTime: result.found ? result.timing.runningTime : undefined,
          isRentalCard: result.found ? result.isRentalCard : undefined,
        };

        setCurrentCard(updated);
        setRecentCards((prev) => {
          const next = prev.map((c) => (c.id === id ? updated : c));
          recentCardsRef.current = next;
          return next;
        });

        // Broadcast to kiosk window (paired mode)
        if (kioskChannelRef.current) {
          kioskChannelRef.current.send(recentCardToKioskMessage(updated));
        }

        // Apply computed result to oRunner (readout station step)
        if (action === "readout" && result.found) {
          try {
            await applyResult.mutateAsync({
              runnerId: result.runner.id,
              status: result.timing.status,
              finishTime: result.timing.finishTime,
              startTime: result.timing.startTime,
            });
            // Invalidate caches so results/runner lists recalculate placements
            // for ALL runners in the class, not just the one just read out.
            // Also invalidate findByCard so ReadoutScreen sees the updated
            // FinishTime without waiting for an unrelated refetch trigger.
            utils.runner.list.invalidate();
            utils.lists.resultList.invalidate();
            utils.runner.findByCard.invalidate({ cardNo: readout.cardNumber });
          } catch {
            console.warn("[DeviceManager] Failed to apply readout result");
          }
        }
      } catch {
        // If the fetch fails, mark as resolved with default action and broadcast
        const fallback: RecentCard = { ...entry, actionResolved: true };
        setCurrentCard(fallback);
        setRecentCards((prev) => {
          const next = prev.map((c) => (c.id === id ? fallback : c));
          recentCardsRef.current = next;
          return next;
        });
        if (kioskChannelRef.current) {
          kioskChannelRef.current.send(recentCardToKioskMessage(fallback));
        }
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
    recentCardsRef.current = [];
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
    };

    const onCardReadout = (e: Event) => {
      const readout = (e as CustomEvent).detail as SICardReadout;
      addRecentCard(readout);
    };

    const onCardRemoved = () => {
      setLastDetectedCardNo(null);
      if (kioskChannelRef.current) {
        kioskChannelRef.current.send({ type: "card-removed" });
      }
    };

    conn.addEventListener("si:status", onStatus);
    conn.addEventListener("si:card-detected", onCardDetected);
    conn.addEventListener("si:card-readout", onCardReadout);
    conn.addEventListener("si:card-removed", onCardRemoved);

    if (supported) {
      conn.tryAutoReconnect().catch(() => {});
    }

    return () => {
      conn.removeEventListener("si:status", onStatus);
      conn.removeEventListener("si:card-detected", onCardDetected);
      conn.removeEventListener("si:card-readout", onCardReadout);
      conn.removeEventListener("si:card-removed", onCardRemoved);
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
    getReaderConnection: getConnection,
  };

  return (
    <DeviceManagerContext.Provider value={value}>
      {children}
    </DeviceManagerContext.Provider>
  );
}
