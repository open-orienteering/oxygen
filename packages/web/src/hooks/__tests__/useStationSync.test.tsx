/**
 * `useStationSync` keeps the runner directory dump out of a kiosk
 * (`{ runnerDb: false }`): the dump needs `race.operate`, which a kiosk key
 * does not carry (docs/system/authentication.md). No DOM runner here, so the
 * hook is rendered to static markup against a recording tRPC mock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { dumpUseQuery, dumpPrefetch, anyUseQuery, prefetch } = vi.hoisted(() => ({
  dumpUseQuery: vi.fn(),
  dumpPrefetch: vi.fn(),
  anyUseQuery: vi.fn(),
  prefetch: vi.fn(),
}));

// Server rendering never runs effects; run them in place so the prefetch effect is exercised.
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return { ...actual, useEffect: (fn: () => void) => void fn() };
});

vi.mock("../../lib/trpc", () => {
  const leaf = () => ({ useQuery: anyUseQuery, prefetch });
  return {
    trpc: {
      useUtils: () => ({
        competition: { dashboard: { prefetch }, clubs: { prefetch }, getRegistrationConfig: { prefetch } },
        runner: { list: { prefetch } },
        control: { list: { prefetch } },
        eventor: { runnerDbDump: { prefetch: dumpPrefetch } },
      }),
      competition: { dashboard: leaf(), clubs: leaf(), getRegistrationConfig: leaf() },
      runner: { list: leaf() },
      control: { list: leaf() },
      eventor: { runnerDbDump: { useQuery: dumpUseQuery } },
    },
  };
});

import { useStationSync } from "../useStationSync";

function Probe(props: { enabled: boolean; runnerDb?: boolean }) {
  useStationSync(props.enabled, props.runnerDb === undefined ? undefined : { runnerDb: props.runnerDb });
  return null;
}

describe("useStationSync runner directory dump", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requests the dump by default", () => {
    renderToStaticMarkup(<Probe enabled />);
    expect(dumpPrefetch).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenCalled(); // the other station data
    expect(dumpUseQuery).toHaveBeenCalledWith(undefined, expect.objectContaining({ enabled: true }));
  });

  it("does not request the dump with runnerDb: false", () => {
    renderToStaticMarkup(<Probe enabled runnerDb={false} />);
    expect(prefetch).toHaveBeenCalled(); // the station still prefetches its other data
    expect(dumpPrefetch).not.toHaveBeenCalled();
    expect(dumpUseQuery).toHaveBeenCalledWith(undefined, expect.objectContaining({ enabled: false }));
  });

  it("stays idle while the sync itself is disabled", () => {
    renderToStaticMarkup(<Probe enabled={false} />);
    expect(dumpPrefetch).not.toHaveBeenCalled();
    expect(dumpUseQuery).toHaveBeenCalledWith(undefined, expect.objectContaining({ enabled: false }));
  });
});
