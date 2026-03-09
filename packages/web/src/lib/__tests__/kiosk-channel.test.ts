/**
 * Unit tests for kiosk-channel helpers.
 *
 * Tests recentCardToKioskMessage mapping from RecentCard to KioskMessage.
 */

import { describe, it, expect } from "vitest";
import { recentCardToKioskMessage } from "../kiosk-channel";
import type { RecentCard } from "../../context/DeviceManager";

function makeCard(overrides: Partial<RecentCard> = {}): RecentCard {
  return {
    id: "test-123",
    cardNumber: 12345,
    cardType: "SI10",
    timestamp: new Date("2026-03-08T10:00:00"),
    action: "register",
    actionResolved: true,
    hasRaceData: false,
    ownerData: null,
    ...overrides,
  };
}

describe("recentCardToKioskMessage", () => {
  it("maps register action correctly", () => {
    const card = makeCard({ action: "register" });
    const msg = recentCardToKioskMessage(card);

    expect(msg.type).toBe("card-readout");
    expect(msg.card.action).toBe("register");
    expect(msg.card.cardNumber).toBe(12345);
    expect(msg.card.cardType).toBe("SI10");
    expect(msg.card.hasRaceData).toBe(false);
  });

  it("maps pre-start action with runner info", () => {
    const card = makeCard({
      action: "pre-start",
      runnerName: "Alice Smith",
      className: "H21",
      clubName: "OK Test",
    });
    const msg = recentCardToKioskMessage(card);

    expect(msg.card.action).toBe("pre-start");
    expect(msg.card.runnerName).toBe("Alice Smith");
    expect(msg.card.className).toBe("H21");
    expect(msg.card.clubName).toBe("OK Test");
  });

  it("maps readout action with running time and status", () => {
    const card = makeCard({
      action: "readout",
      hasRaceData: true,
      runnerName: "Bob Jones",
      runningTime: 12340,
      status: "OK",
    });
    const msg = recentCardToKioskMessage(card);

    expect(msg.card.action).toBe("readout");
    expect(msg.card.hasRaceData).toBe(true);
    expect(msg.card.runnerName).toBe("Bob Jones");
    expect(msg.card.runningTime).toBe(12340);
    expect(msg.card.status).toBe("OK");
  });

  it("includes SI card times from readout", () => {
    const card = makeCard({
      readout: {
        cardNumber: 12345,
        cardType: "SI10",
        punches: [],
        checkTime: 36000,
        startTime: 36100,
        finishTime: 37200,
        clearTime: 35900,
      } as any,
    });
    const msg = recentCardToKioskMessage(card);

    expect(msg.card.checkTime).toBe(36000);
    expect(msg.card.startTime).toBe(36100);
    expect(msg.card.finishTime).toBe(37200);
    expect(msg.card.clearTime).toBe(35900);
  });

  it("omits readout times when no readout present", () => {
    const card = makeCard();
    const msg = recentCardToKioskMessage(card);

    expect(msg.card.checkTime).toBeUndefined();
    expect(msg.card.startTime).toBeUndefined();
    expect(msg.card.finishTime).toBeUndefined();
    expect(msg.card.clearTime).toBeUndefined();
  });
});
