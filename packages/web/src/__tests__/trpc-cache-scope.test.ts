import { describe, expect, it } from "vitest";
import { scopeTrpcUrl } from "../lib/trpc";

describe("scopeTrpcUrl", () => {
  it("separates service-worker cache URLs by event", () => {
    const request = "/trpc/course.mapMetadata?batch=1";

    expect(scopeTrpcUrl(request, "event-a")).toBe(
      "/trpc/course.mapMetadata?batch=1&event=event-a",
    );
    expect(scopeTrpcUrl(request, "event-b")).not.toBe(
      scopeTrpcUrl(request, "event-a"),
    );
  });

  it("leaves non-event requests unchanged", () => {
    expect(scopeTrpcUrl("/trpc/competition.list?batch=1", null)).toBe(
      "/trpc/competition.list?batch=1",
    );
  });
});
