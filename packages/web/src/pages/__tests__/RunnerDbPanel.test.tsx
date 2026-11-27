/**
 * `eventor.runnerDbStatus` needs event.manage: the panel only runs the query
 * for a user who holds it, so nobody else triggers (or sees) a refusal.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { statusUseQuery, caps } = vi.hoisted(() => ({
  statusUseQuery: vi.fn(() => ({ data: undefined, error: null })),
  caps: { loaded: true as boolean, has: (_c: string) => true as boolean },
}));

vi.mock("../../context/CapabilitiesContext", () => ({ useCapabilities: () => caps }));
vi.mock("../../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ eventor: { runnerDbDump: { invalidate: vi.fn() } } }),
    eventor: {
      runnerDbStatus: { useQuery: statusUseQuery },
      syncRunnerDb: { useMutation: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false, isError: false }) },
    },
  },
}));

import { RunnerDbPanel } from "../EventPage";

describe("RunnerDbPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs the status query for a user with event.manage", () => {
    caps.loaded = true;
    caps.has = (c) => c === "event.manage";
    renderToStaticMarkup(<RunnerDbPanel env="prod" />);
    expect(statusUseQuery).toHaveBeenCalledWith(undefined, expect.objectContaining({ enabled: true }));
  });

  it("does not run it without event.manage, nor before the capabilities are known", () => {
    caps.loaded = true;
    caps.has = () => false;
    renderToStaticMarkup(<RunnerDbPanel env="prod" />);
    expect(statusUseQuery).toHaveBeenLastCalledWith(undefined, expect.objectContaining({ enabled: false }));
    caps.loaded = false;
    caps.has = () => true;
    renderToStaticMarkup(<RunnerDbPanel env="prod" />);
    expect(statusUseQuery).toHaveBeenLastCalledWith(undefined, expect.objectContaining({ enabled: false }));
  });
});
