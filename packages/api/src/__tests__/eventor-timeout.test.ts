import { afterEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  EVENTOR_DOWNLOAD_TIMEOUT_MS,
  EVENTOR_REQUEST_TIMEOUT_MS,
  EVENTOR_UPLOAD_TIMEOUT_MS,
  EventorTimeoutError,
  fetchCachedCompetitors,
  uploadResults,
} from "../eventor.js";
import { eventorFetch } from "../eventor.js";
import { withPushGuard } from "../routers/eventor.js";
import { createCallerFactory, router, publicProcedure } from "../trpc.js";

/** A fetch that never answers and rejects when its signal aborts. */
function hangingFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            rej(e);
          });
        }),
    ),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Eventor timeouts", () => {
  it("a stalled upload becomes an outcome-unknown error", async () => {
    vi.useFakeTimers();
    hangingFetch();
    const p = uploadResults("k", "1", "Ev", "2026-08-23", []);
    const assertion = expect(p).rejects.toMatchObject({
      phase: "upload",
      message: expect.stringContaining("EVENTOR_OUTCOME_UNKNOWN"),
    });
    await vi.advanceTimersByTimeAsync(EVENTOR_UPLOAD_TIMEOUT_MS + 1);
    await assertion;
  });

  it("a stalled read becomes a timeout error", async () => {
    vi.useFakeTimers();
    hangingFetch();
    const p = eventorFetch("events", "k");
    const assertion = expect(p).rejects.toMatchObject({
      phase: "request",
      message: expect.stringContaining("EVENTOR_TIMEOUT: Eventor did not answer within 60 s"),
    });
    await vi.advanceTimersByTimeAsync(EVENTOR_REQUEST_TIMEOUT_MS + 1);
    await assertion;
  });

  it("the competitor download has the longer deadline", async () => {
    vi.useFakeTimers();
    hangingFetch();
    const p = fetchCachedCompetitors("k");
    const assertion = expect(p).rejects.toBeInstanceOf(EventorTimeoutError);
    await vi.advanceTimersByTimeAsync(EVENTOR_REQUEST_TIMEOUT_MS + 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(EVENTOR_DOWNLOAD_TIMEOUT_MS);
    await assertion;
  });

  it("other errors pass through unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    await expect(eventorFetch("events", "k")).rejects.toThrow(/Eventor API error: 500/);
  });
});

describe("withPushGuard", () => {
  it("refuses a second concurrent push for the same key, then releases", async () => {
    let release!: () => void;
    const first = withPushGuard("1:results", () => new Promise<void>((r) => (release = r)));
    await expect(withPushGuard("1:results", async () => 1)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("EVENTOR_PUSH_IN_PROGRESS"),
    });
    // Another event or kind is not blocked.
    await expect(withPushGuard("1:startlist", async () => 2)).resolves.toBe(2);
    await expect(withPushGuard("2:results", async () => 3)).resolves.toBe(3);
    release();
    await first;
    await expect(withPushGuard("1:results", async () => 4)).resolves.toBe(4);
  });

  it("releases after a failure and maps a timeout to TIMEOUT", async () => {
    await expect(
      withPushGuard("9:results", async () => {
        throw new EventorTimeoutError("upload", 60_000);
      }),
    ).rejects.toSatisfy((e) => e instanceof TRPCError && e.code === "TIMEOUT" && /OUTCOME_UNKNOWN/.test(e.message));
    await expect(withPushGuard("9:results", async () => "ok")).resolves.toBe("ok");
    await expect(
      withPushGuard("9:results", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withPushGuard("9:results", async () => "ok")).resolves.toBe("ok");
  });
});

describe("read-phase timeout through the router", () => {
  it("surfaces as TIMEOUT with the Eventor message, not INTERNAL_SERVER_ERROR", async () => {
    const r = router({
      read: publicProcedure.query(async () => {
        throw new EventorTimeoutError("request", EVENTOR_REQUEST_TIMEOUT_MS);
      }),
    });
    const caller = createCallerFactory(r)({} as never);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(caller.read()).rejects.toSatisfy(
      (e) => e instanceof TRPCError && e.code === "TIMEOUT" && /^EVENTOR_TIMEOUT: .*60 s\. Try again\.$/.test(e.message) && !/Nothing was changed/.test(e.message),
    );
    spy.mockRestore();
  });

  it("a TRPCError-wrapped EventorTimeoutError cause (an upload) surfaces as TIMEOUT and is logged", async () => {
    const r = router({
      wrapped: publicProcedure.mutation(async () => {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "wrapped", cause: new EventorTimeoutError("upload", EVENTOR_UPLOAD_TIMEOUT_MS) });
      }),
    });
    const caller = createCallerFactory(r)({} as never);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(caller.wrapped()).rejects.toSatisfy((e) => e instanceof TRPCError && e.code === "TIMEOUT" && /OUTCOME_UNKNOWN/.test(e.message));
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/^\[tRPC TIMEOUT\] wrapped: EVENTOR_OUTCOME_UNKNOWN/));
    spy.mockRestore();
  });
});
