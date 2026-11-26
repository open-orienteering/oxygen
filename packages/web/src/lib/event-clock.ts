/**
 * The event clock for stations (start, finish, kiosk, start screen).
 *
 * The time of day is the event's own time zone (`events.time_zone`), never
 * the browser's or the server process's (RES-06). The station asks the
 * server for its time now and then, keeps the offset between the server's
 * clock and the device's, and ticks locally from it. Without network (or
 * before the first answer) it keeps ticking from the device clock with the
 * last known offset and zone, so a countdown never freezes and never shows
 * 00:00.
 */

import { DEFAULT_EVENT_TIME_ZONE, isValidTimeZone, timeOfDayDs } from "@oxygen/shared";

export interface ServerTimeAnswer {
  now: number;
  timeZone?: string;
}

const ZONE_KEY = (nameId: string) => `oxygen.eventTimeZone.${nameId}`;

function readZone(nameId: string): string | null {
  try {
    const z = localStorage.getItem(ZONE_KEY(nameId));
    return z && isValidTimeZone(z) ? z : null;
  } catch {
    return null;
  }
}

function writeZone(nameId: string, zone: string): void {
  try {
    localStorage.setItem(ZONE_KEY(nameId), zone);
  } catch {
    // Private mode or blocked storage: the zone is still kept in memory.
  }
}

/**
 * Offset (server − device, ms) from one round trip: the server's answer is
 * taken to be the time at the midpoint of the request.
 */
export function offsetFromRoundTrip(sentAtMs: number, receivedAtMs: number, serverNowMs: number): number {
  return Math.round(serverNowMs - (sentAtMs + receivedAtMs) / 2);
}

export class EventClock {
  offsetMs = 0;
  timeZone: string;
  synced = false;

  private readonly nameId: string;
  private readonly deviceNow: () => number;

  constructor(nameId: string, deviceNow: () => number = () => Date.now()) {
    this.nameId = nameId;
    this.deviceNow = deviceNow;
    this.timeZone = readZone(nameId) ?? DEFAULT_EVENT_TIME_ZONE;
  }

  /** One sync against the server. Network errors keep the last offset. */
  async sync(fetchServerTime: () => Promise<ServerTimeAnswer>): Promise<void> {
    const sent = this.deviceNow();
    let answer: ServerTimeAnswer;
    try {
      answer = await fetchServerTime();
    } catch {
      return;
    }
    const received = this.deviceNow();
    this.offsetMs = offsetFromRoundTrip(sent, received, answer.now);
    if (answer.timeZone && isValidTimeZone(answer.timeZone) && answer.timeZone !== this.timeZone) {
      this.timeZone = answer.timeZone;
      writeZone(this.nameId, answer.timeZone);
    }
    this.synced = true;
  }

  /** Corrected epoch ms. */
  nowMs(): number {
    return this.deviceNow() + this.offsetMs;
  }

  /** Time of day at the event, deciseconds since its midnight. */
  nowDs(): number {
    return timeOfDayDs(this.nowMs(), this.timeZone);
  }
}
