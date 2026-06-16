/**
 * Unit tests for the Livelox HTTP client's relay-leg handling. `fetch` is
 * stubbed so the tests are hermetic — we only assert the request body we send
 * and how we parse the response.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchClassInfo } from "../livelox/fetcher.js";

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

const CLASS_INFO_BODY = {
  general: {
    event: { name: "Kotka-Jukola 2026" },
    class: {
      name: "Jukola",
      relayLegs: [
        { leg: 1, name: "1", participantCount: 859 },
        { leg: 2, name: "2", participantCount: 791 },
      ],
    },
    classBlobUrl: "https://example/blob_relayLeg_01",
  },
};

describe("fetchClassInfo", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(jsonResponse(CLASS_INFO_BODY));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function lastBody(): Record<string, unknown> {
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    return JSON.parse(init.body as string);
  }

  it("does not send relayLegs when no leg is requested", async () => {
    await fetchClassInfo(1208676);
    const body = lastBody();
    expect(body.classIds).toEqual([1208676]);
    expect(body.relayLegs).toBeUndefined();
  });

  it("sends relayLegs:[N] (array form) when a leg is requested", async () => {
    await fetchClassInfo(1208676, 3);
    expect(lastBody().relayLegs).toEqual([3]);
  });

  it("returns the advertised relay legs and class metadata", async () => {
    const info = await fetchClassInfo(1208676, 2);
    expect(info.classBlobUrl).toBe("https://example/blob_relayLeg_01");
    expect(info.eventName).toBe("Kotka-Jukola 2026");
    expect(info.className).toBe("Jukola");
    expect(info.relayLegs).toHaveLength(2);
    expect(info.relayLegs[1]).toEqual({ leg: 2, name: "2", participantCount: 791 });
  });

  it("returns an empty leg list for non-relay classes", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        general: {
          event: { name: "E" },
          class: { name: "C" },
          classBlobUrl: "https://example/blob",
        },
      }),
    );
    const info = await fetchClassInfo(123);
    expect(info.relayLegs).toEqual([]);
  });
});
