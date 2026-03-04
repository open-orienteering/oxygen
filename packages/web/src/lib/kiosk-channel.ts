/**
 * Typed BroadcastChannel wrapper for admin ↔ kiosk communication.
 *
 * Channel name: `oxygen-kiosk-{competitionNameId}`
 *
 * Used in two scenarios:
 * - Paired mode: Admin owns SI reader, forwards card events to kiosk
 * - Registration flow: Admin sends form state, kiosk sends confirmation
 */

import type { RecentCard, CardAction } from "../context/DeviceManager";
import type { SICardOwnerData } from "./si-protocol";

// ─── Message types ──────────────────────────────────────────

export interface KioskCardReadoutMessage {
  type: "card-readout";
  card: {
    id: string;
    cardNumber: number;
    cardType: string;
    action: CardAction;
    hasRaceData: boolean;
    runnerName?: string;
    className?: string;
    clubName?: string;
    status?: string;
    runningTime?: number;
    ownerData?: SICardOwnerData | null;
    /** Readout times (seconds since midnight, from SI card) */
    checkTime?: number | null;
    startTime?: number | null;
    finishTime?: number | null;
    clearTime?: number | null;
  };
}

export interface RegistrationFormState {
  name: string;
  clubName: string;
  className: string;
  courseName: string;
  cardNo: number;
  startTime: string; // formatted HH:MM:SS
  sex: string;
  birthYear: string;
  phone: string;
  paymentMode: "billed" | "on-site" | "";
  writeToCard?: boolean;
}

export interface KioskRegistrationStateMessage {
  type: "registration-state";
  form: RegistrationFormState;
  /** Admin has finished entering data and is awaiting confirmation */
  ready: boolean;
}

export interface KioskRegistrationCompleteMessage {
  type: "registration-complete";
  runner: {
    name: string;
    className: string;
    clubName: string;
    startTime: string;
    cardNo: number;
  };
}

export interface KioskRegistrationConfirmMessage {
  type: "registration-confirm";
  confirmed: boolean;
}

export interface KioskCardReadingMessage {
  type: "card-reading";
  cardNumber: number;
}

export interface KioskResetMessage {
  type: "kiosk-reset";
}

export interface KioskPingMessage {
  type: "kiosk-ping";
  from: "admin" | "kiosk";
}

export type KioskMessage =
  | KioskCardReadoutMessage
  | KioskCardReadingMessage
  | KioskRegistrationStateMessage
  | KioskRegistrationCompleteMessage
  | KioskRegistrationConfirmMessage
  | KioskResetMessage
  | KioskPingMessage;

// ─── Channel wrapper ────────────────────────────────────────

export class KioskChannel {
  private channel: BroadcastChannel;
  private listeners = new Set<(msg: KioskMessage) => void>();

  constructor(competitionNameId: string) {
    this.channel = new BroadcastChannel(`oxygen-kiosk-${competitionNameId}`);
    this.channel.onmessage = (event: MessageEvent) => {
      const msg = event.data as KioskMessage;
      if (msg && typeof msg.type === "string") {
        for (const listener of this.listeners) {
          listener(msg);
        }
      }
    };
  }

  send(msg: KioskMessage): void {
    this.channel.postMessage(msg);
  }

  subscribe(listener: (msg: KioskMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Send a ping and return true if we get a response within timeoutMs */
  async ping(from: "admin" | "kiosk", timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
      const expectedFrom = from === "admin" ? "kiosk" : "admin";
      const unsub = this.subscribe((msg) => {
        if (msg.type === "kiosk-ping" && msg.from === expectedFrom) {
          clearTimeout(timer);
          unsub();
          resolve(true);
        }
      });
      const timer = setTimeout(() => {
        unsub();
        resolve(false);
      }, timeoutMs);
      this.send({ type: "kiosk-ping", from });
    });
  }

  close(): void {
    this.channel.close();
    this.listeners.clear();
  }
}

// ─── Helpers ────────────────────────────────────────────────

/** Convert a RecentCard to a KioskCardReadoutMessage */
export function recentCardToKioskMessage(
  card: RecentCard,
): KioskCardReadoutMessage {
  return {
    type: "card-readout",
    card: {
      id: card.id,
      cardNumber: card.cardNumber,
      cardType: card.cardType,
      action: card.action,
      hasRaceData: card.hasRaceData,
      runnerName: card.runnerName,
      className: card.className,
      clubName: card.clubName,
      status: card.status,
      runningTime: card.runningTime,
      ownerData: card.ownerData,
      checkTime: card.readout?.checkTime,
      startTime: card.readout?.startTime,
      finishTime: card.readout?.finishTime,
      clearTime: card.readout?.clearTime,
    },
  };
}
