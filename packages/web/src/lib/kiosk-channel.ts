/**
 * Typed BroadcastChannel wrapper for admin ↔ kiosk communication —
 * being re-ported. Minimal placeholder so callers compile until the
 * device-manager + punch-matcher land.
 */

export type CardAction = "readout" | "register" | "pre-start";

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
  };
}

export interface RegistrationFormState {
  type: "registration-form-state";
  cardNumber?: number;
  name?: string;
  className?: string;
  clubName?: string;
}

export type KioskMessage = KioskCardReadoutMessage | RegistrationFormState;

export type KioskMessageHandler = (msg: KioskMessage) => void;

export class KioskChannel {
  readonly competitionNameId: string;
  constructor(competitionNameId: string) {
    this.competitionNameId = competitionNameId;
  }
  postMessage(_msg: KioskMessage): void {
    void _msg;
  }
  subscribe(_handler: KioskMessageHandler): () => void {
    void _handler;
    return () => {};
  }
  async ping(_who?: string, _timeoutMs?: number): Promise<boolean> {
    void _who;
    void _timeoutMs;
    return false;
  }
  close(): void {}
}

export function recentCardToKioskMessage(): KioskCardReadoutMessage | null {
  return null;
}
