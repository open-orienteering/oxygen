import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveUpdateAction,
  formatBuildVersion,
  formatBuildCommit,
  formatDeployRef,
  createUpdateActivator,
  versionIdentity,
} from "../app-update";

describe("versionIdentity", () => {
  // Cloud Run restarts the process constantly (scale-to-zero, instance
  // swaps) without any code change — the deploy-time build id is the only
  // stable identity there. Comparing startedAt produced a false "update
  // available" prompt on every cold start.
  it("uses the build id when the server provides one", () => {
    expect(
      versionIdentity({ startedAt: "2026-08-31T10:00:00Z", buildId: "abc123" }),
    ).toBe("abc123");
  });

  it("is stable across process restarts of the same build", () => {
    const a = versionIdentity({ startedAt: "2026-08-31T10:00:00Z", buildId: "abc123" });
    const b = versionIdentity({ startedAt: "2026-08-31T11:30:00Z", buildId: "abc123" });
    expect(a).toBe(b);
  });

  it("falls back to startedAt for dev / compose servers without a build id", () => {
    expect(versionIdentity({ startedAt: "2026-08-31T10:00:00Z" })).toBe(
      "2026-08-31T10:00:00Z",
    );
    expect(
      versionIdentity({ startedAt: "2026-08-31T10:00:00Z", buildId: null }),
    ).toBe("2026-08-31T10:00:00Z");
    expect(
      versionIdentity({ startedAt: "2026-08-31T10:00:00Z", buildId: "" }),
    ).toBe("2026-08-31T10:00:00Z");
  });
});

describe("createUpdateActivator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("activates the waiting worker immediately", () => {
    const activate = vi.fn();
    const reload = vi.fn();
    createUpdateActivator({ activate, reload, fallbackMs: 2500 })();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  // The SW-driven reload never fires when the tab isn't controlled by a
  // service worker or the waiting worker vanished — this is the "reload
  // button doesn't register" bug. The fallback hard reload covers it.
  it("hard-reloads when the worker activation doesn't reload the page", () => {
    const activate = vi.fn();
    const reload = vi.fn();
    createUpdateActivator({ activate, reload, fallbackMs: 2500 })();
    vi.advanceTimersByTime(2499);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("schedules only one fallback for repeated clicks", () => {
    const activate = vi.fn();
    const reload = vi.fn();
    const run = createUpdateActivator({ activate, reload, fallbackMs: 2500 });
    run();
    run();
    run();
    vi.advanceTimersByTime(10_000);
    expect(activate).toHaveBeenCalledTimes(3);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("resolveUpdateAction", () => {
  it("reports nothing when both sources are quiet", () => {
    expect(
      resolveUpdateAction({ apiRestarted: false, bundleWaiting: false }),
    ).toEqual({ updateAvailable: false, action: null });
  });

  it("reloads for an API restart", () => {
    expect(
      resolveUpdateAction({ apiRestarted: true, bundleWaiting: false }),
    ).toEqual({ updateAvailable: true, action: "reload" });
  });

  // A plain reload keeps serving the cached bundle, so a waiting worker has
  // to be activated instead — this is the case that stranded an operator on
  // old code after a web-only deploy.
  it("activates the waiting worker for a new bundle", () => {
    expect(
      resolveUpdateAction({ apiRestarted: false, bundleWaiting: true }),
    ).toEqual({ updateAvailable: true, action: "activate-service-worker" });
  });

  it("prefers activating the worker when both fired", () => {
    expect(
      resolveUpdateAction({ apiRestarted: true, bundleWaiting: true }),
    ).toEqual({ updateAvailable: true, action: "activate-service-worker" });
  });
});

describe("formatBuildVersion", () => {
  it("renders a build timestamp as compact local date and time", () => {
    // No zone suffix, so this parses as local time and the expectation holds
    // regardless of the machine's timezone.
    expect(formatBuildVersion("2026-08-25T08:10:00")).toBe("2026-08-25 08:10");
  });

  it("pads single-digit months, days, hours and minutes", () => {
    expect(formatBuildVersion("2026-01-02T03:04:00")).toBe("2026-01-02 03:04");
  });

  it("falls back to the raw string when it isn't a date", () => {
    expect(formatBuildVersion("dev")).toBe("dev");
    expect(formatBuildVersion("")).toBe("");
  });
});

describe("formatBuildCommit", () => {
  it("shortens the full SHA baked into GHCR images", () => {
    expect(
      formatBuildCommit("e81729be4f7fd564c47bb2098137403ef6dcb922"),
    ).toBe("e81729b");
  });

  it("extracts the SHA from legacy source-build identities", () => {
    expect(formatBuildCommit("bfdbf0e-20260918230000")).toBe("bfdbf0e");
  });

  it("omits missing identities", () => {
    expect(formatBuildCommit(null)).toBeNull();
    expect(formatBuildCommit("")).toBeNull();
  });
});

describe("formatDeployRef", () => {
  it("shows only the tag from a full GHCR image reference", () => {
    expect(
      formatDeployRef("ghcr.io/open-orienteering/oxygen:v1.2.3"),
    ).toBe("v1.2.3");
  });

  it("keeps operator-friendly tag and digest values", () => {
    expect(formatDeployRef("edge")).toBe("edge");
    expect(formatDeployRef("sha-abcdef0")).toBe("sha-abcdef0");
    expect(formatDeployRef("ghcr.io/open-orienteering/oxygen@sha256:abc")).toBe(
      "sha256:abc",
    );
  });
});
