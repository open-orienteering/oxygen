import { describe, it, expect, beforeEach } from "vitest";
import {
  attemptSessionReload,
  canAttemptSessionReload,
  clearSessionReloadGuard,
  isNetworkClassError,
  isNotFoundError,
} from "../session-recovery";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
    key: (i) => [...map.keys()][i] ?? null,
  };
}

describe("isNetworkClassError", () => {
  it("detects Failed to fetch / NetworkError messages without a tRPC code", () => {
    expect(isNetworkClassError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkClassError(new Error("NetworkError when attempting to fetch"))).toBe(
      true,
    );
    expect(isNetworkClassError(new Error("Load failed"))).toBe(true);
  });

  it("rejects real tRPC procedure errors that carry a code", () => {
    expect(
      isNetworkClassError({ message: "Event not found", data: { code: "NOT_FOUND" } }),
    ).toBe(false);
    expect(
      isNetworkClassError({ message: "Forbidden", data: { code: "FORBIDDEN" } }),
    ).toBe(false);
  });

  it("rejects unrelated errors", () => {
    expect(isNetworkClassError(null)).toBe(false);
    expect(isNetworkClassError(new Error("something else"))).toBe(false);
  });
});

describe("isNotFoundError", () => {
  it("matches NOT_FOUND data.code only", () => {
    expect(isNotFoundError({ data: { code: "NOT_FOUND" } })).toBe(true);
    expect(isNotFoundError({ data: { code: "BAD_REQUEST" } })).toBe(false);
    expect(isNotFoundError(new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("session reload guard", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = memoryStorage();
    clearSessionReloadGuard(storage);
  });

  it("allows the first reload and blocks within the interval", () => {
    const now = 1_000_000;
    expect(canAttemptSessionReload(now, 15_000, storage)).toBe(true);
    expect(canAttemptSessionReload(now + 1_000, 15_000, storage)).toBe(false);
    expect(canAttemptSessionReload(now + 15_000, 15_000, storage)).toBe(true);
  });

  it("attemptSessionReload invokes reload only when the guard allows it", () => {
    const calls: number[] = [];
    const reload = () => calls.push(1);
    expect(attemptSessionReload(reload, 1_000, 15_000, storage)).toBe(true);
    expect(attemptSessionReload(reload, 2_000, 15_000, storage)).toBe(false);
    expect(calls).toEqual([1]);
  });
});
