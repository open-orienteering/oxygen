import { describe, expect, it } from "vitest";
import { tileRequestKey } from "../components/TileLayer";

describe("tileRequestKey", () => {
  it("isolates tile state by event and uploaded map version", () => {
    const coordinates = [13, 4242, 2222] as const;

    const firstEvent = tileRequestKey(
      "/api/map-tile/event-a",
      "?v=100",
      ...coordinates,
    );
    const secondEvent = tileRequestKey(
      "/api/map-tile/event-b",
      "?v=100",
      ...coordinates,
    );
    const replacementMap = tileRequestKey(
      "/api/map-tile/event-a",
      "?v=200",
      ...coordinates,
    );

    expect(secondEvent).not.toBe(firstEvent);
    expect(replacementMap).not.toBe(firstEvent);
  });
});
