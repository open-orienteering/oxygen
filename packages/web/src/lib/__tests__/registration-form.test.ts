import { describe, expect, it, vi } from "vitest";
import { defaultPaymentMode, registrationErrorMessage } from "../registration-form";
import { withTimeout } from "../receipt-printer/timeout";

const t = ((k: string) => k) as never;

describe("defaultPaymentMode (WEB-19)", () => {
  it("takes the first configured method", () => {
    expect(defaultPaymentMode({ paymentMethods: ["swish", "billed"] })).toBe("swish");
    expect(defaultPaymentMode({ paymentMethods: ["billed", "swish"] })).toBe("billed");
  });
  it("is empty without methods or config, and for an unknown method", () => {
    expect(defaultPaymentMode({ paymentMethods: [] })).toBe("");
    expect(defaultPaymentMode(undefined)).toBe("");
    expect(defaultPaymentMode({ paymentMethods: ["bitcoin"] })).toBe("");
  });
});

describe("registrationErrorMessage (WEB-22)", () => {
  const trpcError = (code: string, message = "x") => Object.assign(new Error(message), { data: { code } });
  it("names a taken card", () => {
    expect(registrationErrorMessage(trpcError("CONFLICT"), t)).toBe("errorCardTaken");
  });
  it("names a missing permission", () => {
    expect(registrationErrorMessage(trpcError("FORBIDDEN"), t)).toBe("errorForbidden");
    expect(registrationErrorMessage(trpcError("UNAUTHORIZED"), t)).toBe("errorForbidden");
  });
  it("names a missing class", () => {
    expect(registrationErrorMessage(trpcError("NOT_FOUND"), t)).toBe("errorNotFound");
  });
  it("names an unreachable server", () => {
    const err = Object.assign(new Error("Failed to fetch"), { cause: new TypeError("Failed to fetch") });
    expect(registrationErrorMessage(err, t)).toBe("errorUnreachable");
  });
  it("keeps the zero-time message", () => {
    expect(
      registrationErrorMessage(trpcError("BAD_REQUEST", "ZERO_TIME_COLLISION: Start on the zero time"), t),
    ).toBe("Start on the zero time");
  });
  it("falls back to the generic text", () => {
    expect(registrationErrorMessage(trpcError("INTERNAL_SERVER_ERROR"), t)).toBe("registrationFailed");
  });
});

describe("withTimeout (WEB-20)", () => {
  it("rejects a promise that never settles", async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise(() => {}), 1000, "printer transfer");
    const assertion = expect(p).rejects.toThrow("printer transfer timed out after 1000 ms");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    vi.useRealTimers();
  });
  it("passes a settled value through", async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, "x")).resolves.toBe(7);
  });
});
