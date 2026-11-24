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
import { ReaderHub, type ReaderInfo } from "../lib/reader-hub";
import type { SIReaderKind } from "../lib/si-reader";
import {
  ReaderBtConnection,
  type BleDeviceLike,
  type ReaderBtAvailability,
} from "../lib/reader-bt";
import { ReaderConnectionDialog } from "../components/ReaderConnectionDialog";
import type { SICardReadout, SICardOwnerData } from "../lib/si-protocol";
import { trpc, activeEventNameId } from "../lib/trpc";
import { useCurrentUser } from "./CurrentUserContext";
import { canApplyResults, findDuplicate, readoutsMatch as sameReadout, withTimeout, type SaveState } from "../lib/offline/readout-policy";
import { KioskChannel, recentCardToKioskMessage } from "../lib/kiosk-channel";
import { RunnerStatus, meosFromVolts, runnerStatusLabel, type RunnerStatusValue } from "@oxygen/shared";
import { emitEvent } from "../lib/offline/events";
import { toOfflineCardReadPayload } from "../lib/offline/card-read-payload";
import { computeCardReadout, lookupRunnerByCard } from "../lib/offline/local-readout";
import { useQueryClient } from "@tanstack/react-query";

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
  /** Event (URL nameId) the readout was taken in; a re-read in another event is not a duplicate. */
  competitionId?: string | null;
  /** Stored on the server or queued in the outbox. Only then is a re-read a duplicate. */
  persisted?: boolean;
  /** How the readout was saved; "not-saved" / "no-competition" ask the operator to read the card again. */
  saveState?: SaveState;
}

interface DeviceManagerState {
  /** Any reader transport is available in this browser. */
  supported: boolean;
  /** Web Serial is available (USB SI stations). */
  serialSupported: boolean;
  /** Whether a Reader BT can be added, and if not, why ("checking" until known). */
  bleSupport: ReaderBtAvailability | "checking";
  /** Best status across all readers ("reading" if any reader is live). */
  readerStatus: SIReaderStatus;
  /** Best status across USB SI stations only (station programming needs one). */
  serialStatus: SIReaderStatus;
  /** Every reader the hub knows, connected or not. */
  readers: ReaderInfo[];
  /**
   * Connect a reader of the given kind (default: USB SI station). Opens the
   * browser's device picker, so call it from a user gesture.
   */
  connectReader: (kind?: SIReaderKind) => Promise<void>;
  /** Disconnect one reader, or every reader when no id is given. */
  disconnectReader: (id?: string) => Promise<void>;
  /** Disconnect a reader and drop it from the list. */
  removeReader: (id: string) => Promise<void>;
  /** Drop a Reader BT and revoke the browser's permission for it. */
  forgetReader: (id: string) => Promise<void>;
  /** Wait for an idle Reader BT to advertise (a card inserted) and reconnect. */
  reconnectReader: (id: string) => Promise<void>;
  readerDialogOpen: boolean;
  openReaderDialog: () => void;
  closeReaderDialog: () => void;
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
  /**
   * The USB SI station used for station programming operations. With several
   * USB stations this is the first one; with none, an unconnected instance
   * that `connectReader("serial")` will connect.
   */
  getReaderConnection: () => SIReaderConnection;
}

const MAX_RECENT = 20;
/** Longest the server store may take before the readout is queued instead (SI-29). */
const STORE_TIMEOUT_MS = 8000;

// ─── Remembered Reader BTs ─────────────────────────────────
// Chromium's getDevices() returns every device this origin was ever granted;
// this list is what Oxygen reconnects on load, so "Forget" means something
// even where device.forget() is missing.

const BT_DEVICES_KEY = "oxygen-reader-bt-devices";

interface RememberedBtDevice {
  id: string;
  name: string | null;
  lastSeen: number;
}

function loadRememberedBt(): RememberedBtDevice[] {
  try {
    const raw = JSON.parse(localStorage.getItem(BT_DEVICES_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((d) => typeof d?.id === "string") : [];
  } catch {
    return [];
  }
}

function saveRememberedBt(list: RememberedBtDevice[]): void {
  try {
    localStorage.setItem(BT_DEVICES_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}

function rememberBt(device: BleDeviceLike): void {
  const rest = loadRememberedBt().filter((d) => d.id !== device.id);
  saveRememberedBt([...rest, { id: device.id, name: device.name ?? null, lastSeen: Date.now() }]);
}

function forgetBt(deviceId: string): void {
  saveRememberedBt(loadRememberedBt().filter((d) => d.id !== deviceId));
}

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

// ─── Provider ──────────────────────────────────────────────

export function DeviceManagerProvider({ children }: { children: ReactNode }) {
  const serialSupported = SIReaderConnection.isSupported();
  const supported = serialSupported || ReaderBtConnection.isSupported();
  const [bleSupport, setBleSupport] = useState<ReaderBtAvailability | "checking">("checking");
  const hubRef = useRef<ReaderHub | null>(null);

  const [readerStatus, setReaderStatus] = useState<SIReaderStatus>("idle");
  const [serialStatus, setSerialStatus] = useState<SIReaderStatus>("idle");
  const [readers, setReaders] = useState<ReaderInfo[]>([]);
  const [readerDialogOpen, setReaderDialogOpen] = useState(false);
  const [currentCard, setCurrentCard] = useState<RecentCard | null>(null);
  const [recentCards, setRecentCards] = useState<RecentCard[]>([]);
  const [isOnCardReadoutPage, setIsOnCardReadoutPage] = useState(false);
  const [lastDetectedCardNo, setLastDetectedCardNo] = useState<number | null>(null);

  const competitionNameIdRef = useRef<string | null>(null);
  const kioskChannelRef = useRef<KioskChannel | null>(null);
  // Legacy refs kept as no-ops for interface compat
  const pendingConfirmCardNoRef = useRef<number | null>(null);
  const pendingConfirmCallbackRef = useRef<(() => void) | null>(null);

  const { authEnabled, user } = useCurrentUser();
  const canApplyRef = useRef(true);
  canApplyRef.current = canApplyResults(authEnabled, user !== null);

  const storeReadout = trpc.cardReadout.storeReadout.useMutation();
  const applyResult = trpc.cardReadout.applyResult.useMutation();
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();

  // TestLab injection BroadcastChannel
  const testLabChannelRef = useRef<BroadcastChannel | null>(null);

  // Manage kiosk BroadcastChannel lifecycle
  const setCompetitionNameId = useCallback((nameId: string | null) => {
    competitionNameIdRef.current = nameId;
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

  const getHub = useCallback((): ReaderHub => {
    if (!hubRef.current) hubRef.current = new ReaderHub();
    return hubRef.current;
  }, []);

  /** First USB station; creates an unconnected one if there is none. */
  const getConnection = useCallback((): SIReaderConnection => {
    const hub = getHub();
    const existing = hub.firstOfKind("serial");
    if (existing) return existing as SIReaderConnection;
    const conn = new SIReaderConnection();
    hub.add(conn);
    return conn;
  }, [getHub]);

  // ── Process a card read ─────────────────────────────────

  // Track recent readouts for deduplication (ref to avoid stale closure issues)
  const recentCardsRef = useRef<RecentCard[]>([]);

  const addRecentCard = useCallback(
    async (readout: SICardReadout) => {
      // Deduplicate: if same card with identical punch data already exists,
      // reuse the entry (update timestamp) but still re-resolve action from DB
      // (runner may have been registered since last read).
      // The event comes from the URL, the same source as the x-competition-id
      // header, so a queued entry always lands where an online store would
      // have. (The old ref was only set by CompetitionShell; the standalone
      // kiosk route never set it: SYNC-03 / SI-03.)
      const competition = activeEventNameId();
      const existing = findDuplicate(recentCardsRef.current, readout, competition);
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
            competitionId: competition,
            persisted: false,
            saveState: "saving",
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
          // An earlier identical read that never got saved is replaced, not stacked.
          const next = [
            entry,
            ...prev.filter((c) => !(c.readout && !c.persisted && sameReadout(c.readout, readout))),
          ].slice(0, MAX_RECENT);
          recentCardsRef.current = next;
          return next;
        });
      }

      // Queue the card read in this device's outbox. True only when the entry
      // really is in IndexedDB: the UI must not claim a save that did not
      // happen (SYNC-24), and a read that was not saved must not count as a
      // duplicate of the next insert (SI-16).
      const queueCardRead = async (): Promise<SaveState> => {
        if (!competition) {
          console.warn("[DeviceManager] No event in the URL: cannot queue the card read");
          return "no-competition";
        }
        try {
          await emitEvent("card.read", competition, toOfflineCardReadPayload(readout, raceData));
          return "queued";
        } catch (err) {
          console.error("[DeviceManager] Could not queue the card read", err);
          return "not-saved";
        }
      };

      // Store card data on the server (skip if duplicate — already stored)
      let serverPunchesRelevant = true;
      let storeFailed = false;
      let saveState: SaveState = "saved";
      if (!isDuplicate) {
        if (navigator.onLine) {
          try {
            // SI readouts use seconds-since-midnight; the API contract is
            // absolute deciseconds, so multiply by 10 on the way out.
            // An 8 s cap (SI-29): on a black-holed network the call can hang
            // for minutes; the server dedups a late delivery against the
            // queued entry.
            const storeResult = await withTimeout(
              storeReadout.mutateAsync({
                cardNo: readout.cardNumber,
                punches: readout.punches.map((p) => ({
                  controlCode: p.controlCode,
                  time: p.time * 10,
                  ...(p.subSecond != null ? { subSecond: p.subSecond } : {}),
                })),
                checkTime:
                  readout.checkTime !== null && readout.checkTime !== undefined
                    ? readout.checkTime * 10
                    : undefined,
                startTime:
                  readout.startTime !== null && readout.startTime !== undefined
                    ? readout.startTime * 10
                    : undefined,
                finishTime:
                  readout.finishTime !== null && readout.finishTime !== undefined
                    ? readout.finishTime * 10
                    : undefined,
                cardType: readout.cardType,
                punchesFresh: raceData,
                // SICardReadout carries volts; the API takes integer mV (MeOS).
                batteryVoltage: meosFromVolts(readout.batteryVoltage) ?? undefined,
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
              }),
              STORE_TIMEOUT_MS,
            );
            serverPunchesRelevant = storeResult.punchesRelevant ?? true;
          } catch (err) {
            console.warn("[DeviceManager] Failed to store readout on server — queuing offline event");
            // Only an unreachable or too-slow server skips the server fetch. A
            // server that answered with an error (a kiosk key refused for
            // writes, a lease refusal) can still resolve the card: the kiosk
            // key may call cardReadout.readout.
            storeFailed = (err as { data?: { code?: string } } | null)?.data?.code === undefined;
            saveState = await queueCardRead();
          }
        } else {
          // Offline — queue the card read event immediately
          saveState = await queueCardRead();
        }
      }
      const persisted = isDuplicate || saveState === "saved" || saveState === "queued";
      const savedEntry: RecentCard = isDuplicate ? { ...entry } : { ...entry, persisted, saveState };
      setCurrentCard(savedEntry);
      setRecentCards((prev) => {
        const next = prev.map((c) => (c.id === id ? savedEntry : c));
        recentCardsRef.current = next;
        return next;
      });

      // Invalidate cache and resolve from server (only when online)
      const useServer = navigator.onLine && !storeFailed;
      if (useServer) {
        await utils.cardReadout.readout.invalidate({ cardNo: readout.cardNumber });
      }

      // Resolve runner info and determine action (always — even for duplicates)
      try {
        // A failed store means the server is unreachable (or too slow): resolve
        // from the local cache instead of waiting out a second request (SI-15).
        const result = useServer
          ? await utils.cardReadout.readout.fetch({ cardNo: readout.cardNumber })
          : null;

        // Offline — skip to catch block for local resolution
        if (!result) throw new Error("offline");

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
            dbStatus > 0 && dbStatus !== RunnerStatus.DNS && dbStatus !== RunnerStatus.Cancel;

          // Server-side match score (0.0–1.0): how well do the card's
          // punches match the runner's assigned course? Penalized by
          // foreign punches (controls not in this competition).
          const matchScore = result.matchScore ?? 0;
          const punchesRelevant = matchScore >= 0.2;

          if (punchesRelevant || hasDbResult) {
            // Runner found AND (punches match this competition OR already has result in DB) → readout
            action = "readout";
            status = result.timing.status > 0
              ? runnerStatusLabel(result.timing.status as RunnerStatusValue)
              : undefined;
          } else {
            // Runner found but punches are stale/absent and no result → pre-start
            action = "pre-start";
          }
        }

        const updated: RecentCard = {
          ...savedEntry,
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
        if (action === "readout" && result.found && navigator.onLine) {
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
            console.warn("[DeviceManager] Failed to apply readout result — queuing offline event");
            if (competition && canApplyRef.current) {
              try {
                await emitEvent("result.applied", competition, {
                  runnerId: result.runner.id,
                  cardNo: result.runner.cardNo,
                  status: result.timing.status,
                  finishTime: result.timing.finishTime,
                  startTime: result.timing.startTime,
                });
              } catch (err) {
                console.error("[DeviceManager] Could not queue the result", err);
              }
            }
          }
        }
      } catch {
        // Server unreachable — try local readout from cached data
        const localResult = computeCardReadout(
          {
            cardNo: readout.cardNumber,
            punches: readout.punches.map((p) => ({ controlCode: p.controlCode, time: p.time })),
            startTime: readout.startTime ?? undefined,
            finishTime: readout.finishTime ?? undefined,
          },
          queryClient,
          competition,
        );

        if (localResult && localResult.punchesRelevant) {
          // We have cached data — resolve locally
          const status = localResult.timing.status > 0
            ? runnerStatusLabel(localResult.timing.status as RunnerStatusValue)
            : undefined;

          const offlineResolved: RecentCard = {
            ...savedEntry,
            action: "readout",
            actionResolved: true,
            hasRaceData: true,
            runnerName: localResult.runner.name,
            className: localResult.runner.className,
            clubName: localResult.runner.clubName,
            status,
            runningTime: localResult.timing.runningTime,
          };

          setCurrentCard(offlineResolved);
          setRecentCards((prev) => {
            const next = prev.map((c) => (c.id === id ? offlineResolved : c));
            recentCardsRef.current = next;
            return next;
          });
          if (kioskChannelRef.current) {
            kioskChannelRef.current.send(recentCardToKioskMessage(offlineResolved));
          }

          // Emit result.applied for later sync. The competition comes from the
          // URL (the old closure value was always null, so this never ran:
          // SI-02 / MC-06) and only a device that may write results queues it
          // (D11: a kiosk-key-only device queues just its card.read).
          if (competition && canApplyRef.current) {
            try {
              await emitEvent("result.applied", competition, {
                runnerId: localResult.runner.id,
                cardNo: localResult.runner.cardNo,
                status: localResult.timing.status,
                finishTime: localResult.timing.finishTime,
                startTime: localResult.timing.startTime,
              });
            } catch (err) {
              console.error("[DeviceManager] Could not queue the result", err);
            }
          }
        } else {
          // No cached data or runner not found — check if runner exists in cache at all
          const cachedRunner = lookupRunnerByCard(readout.cardNumber, queryClient, competition);
          const fallback: RecentCard = {
            ...savedEntry,
            actionResolved: true,
            action: cachedRunner ? "pre-start" : "register",
            runnerName: cachedRunner?.name,
            className: cachedRunner?.className,
            clubName: cachedRunner?.clubName,
          };
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
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ── Connect / disconnect ────────────────────────────────

  const connectReader = useCallback(
    async (kind: SIReaderKind = "serial") => {
      const hub = getHub();
      if (kind === "ble") {
        // The picker throws NotFoundError on cancel, before anything is added.
        const device = await ReaderBtConnection.requestDevice();
        const existing = hub.get(`ble:${device.id}`) as ReaderBtConnection | undefined;
        const reader = existing ?? new ReaderBtConnection(device);
        hub.add(reader);
        rememberBt(device);
        if (!reader.isConnected) await reader.connect();
        return;
      }
      // Reuse an unconnected USB station (the one ControlsPage may already
      // hold via getReaderConnection) before adding another.
      const idle = hub
        .list()
        .find((r) => r.kind === "serial" && !r.isConnected && r.status !== "connecting");
      const conn = (idle as SIReaderConnection | undefined) ?? new SIReaderConnection();
      hub.add(conn);
      await conn.connect();
    },
    [getHub],
  );

  const disconnectReader = useCallback(
    async (id?: string) => {
      const hub = getHub();
      const targets = id ? hub.list().filter((r) => r.id === id) : hub.list();
      await Promise.all(targets.map((r) => r.disconnect().catch(() => {})));
    },
    [getHub],
  );

  const removeReader = useCallback(
    async (id: string) => {
      await getHub().remove(id);
    },
    [getHub],
  );

  const forgetReader = useCallback(
    async (id: string) => {
      const reader = getHub().get(id);
      if (reader instanceof ReaderBtConnection) forgetBt(reader.device.id);
      await getHub().remove(id, { forget: true });
    },
    [getHub],
  );

  const reconnectReader = useCallback(
    async (id: string) => {
      const reader = getHub().get(id);
      if (reader instanceof ReaderBtConnection && !reader.isConnected) {
        await reader.connectWhenAdvertising();
      }
    },
    [getHub],
  );

  const clearRecentCards = useCallback(() => {
    setRecentCards([]);
    recentCardsRef.current = [];
    setCurrentCard(null);
  }, []);

  // ── Wire up event listeners ─────────────────────────────

  useEffect(() => {
    const conn = getHub();

    const onStatus = (e: Event) => {
      const status = (e as CustomEvent).detail.status as SIReaderStatus;
      setReaderStatus(status);
      setSerialStatus(conn.aggregateStatus("serial"));
    };

    const onReadersChanged = (e: Event) => {
      setReaders((e as CustomEvent).detail as ReaderInfo[]);
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

    const onCardRemoved = (e: Event) => {
      // With several readers, only the reader that reported the last insert
      // may clear the kiosk's "do not remove the card" screen.
      const readerId = (e as CustomEvent).detail?.readerId as string | undefined;
      if (readerId && conn.lastDetectionReaderId && readerId !== conn.lastDetectionReaderId) {
        return;
      }
      setLastDetectedCardNo(null);
      if (kioskChannelRef.current) {
        kioskChannelRef.current.send({ type: "card-removed" });
      }
    };

    conn.addEventListener("si:status", onStatus);
    conn.addEventListener("si:card-detected", onCardDetected);
    conn.addEventListener("si:card-readout", onCardReadout);
    conn.addEventListener("si:card-removed", onCardRemoved);
    conn.addEventListener("hub:readers-changed", onReadersChanged);
    setReaders(conn.snapshot());

    // Reopen every USB station this origin was granted before (no picker).
    let cancelled = false;
    if (serialSupported) {
      SIReaderConnection.grantedPorts()
        .then(async (ports) => {
          for (const port of ports) {
            if (cancelled) return;
            const held = conn
              .list()
              .some((r) => r instanceof SIReaderConnection && r.holdsPort(port));
            if (held) continue;
            const idle = conn
              .list()
              .find((r) => r instanceof SIReaderConnection && r.status === "idle");
            const reader = (idle as SIReaderConnection | undefined) ?? new SIReaderConnection();
            conn.add(reader);
            await reader.attach(port).catch(() => {
              // Port busy (another tab) or unplugged; the row stays in error.
            });
          }
        })
        .catch(() => {});
    }

    // Reader BTs remembered from an earlier visit: wait for each to advertise
    // (the next card inserted wakes it) and reconnect without a picker.
    ReaderBtConnection.availability()
      .then(async (availability) => {
        if (cancelled) return;
        setBleSupport(availability);
        if (availability !== "ok") return;
        const remembered = new Set(loadRememberedBt().map((d) => d.id));
        if (remembered.size === 0) return;
        for (const device of await ReaderBtConnection.rememberedDevices()) {
          if (cancelled) return;
          if (!remembered.has(device.id) || conn.get(`ble:${device.id}`)) continue;
          const reader = new ReaderBtConnection(device);
          conn.add(reader);
          void reader.connectWhenAdvertising().then((ok) => {
            if (ok) rememberBt(device);
          });
        }
      })
      .catch(() => setBleSupport("unsupported"));

    return () => {
      cancelled = true;
      conn.removeEventListener("hub:readers-changed", onReadersChanged);
      conn.removeEventListener("si:status", onStatus);
      conn.removeEventListener("si:card-detected", onCardDetected);
      conn.removeEventListener("si:card-readout", onCardReadout);
      conn.removeEventListener("si:card-removed", onCardRemoved);
    };
  }, [getHub, addRecentCard, serialSupported]);

  const getKioskChannel = useCallback(() => kioskChannelRef.current, []);

  const setPendingConfirmCardNo = useCallback((cardNo: number | null, onConfirm?: () => void) => {
    pendingConfirmCardNoRef.current = cardNo;
    pendingConfirmCallbackRef.current = onConfirm ?? null;
  }, []);

  const openReaderDialog = useCallback(() => setReaderDialogOpen(true), []);
  const closeReaderDialog = useCallback(() => setReaderDialogOpen(false), []);

  const value: DeviceManagerState = {
    supported,
    serialSupported,
    bleSupport,
    readerStatus,
    serialStatus,
    readers,
    connectReader,
    disconnectReader,
    removeReader,
    forgetReader,
    reconnectReader,
    readerDialogOpen,
    openReaderDialog,
    closeReaderDialog,
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
      {readerDialogOpen && <ReaderConnectionDialog onClose={closeReaderDialog} />}
    </DeviceManagerContext.Provider>
  );
}
