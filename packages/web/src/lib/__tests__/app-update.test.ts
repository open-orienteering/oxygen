import { describe, it, expect } from "vitest";
import { resolveUpdateAction, formatBuildVersion } from "../app-update";

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
