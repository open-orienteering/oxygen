import { describe, it, expect, beforeEach, vi } from "vitest";
import { createEventorKeyStore, type KeyStoreDeps } from "../eventorKeyStore.js";
import { EventorAuthError, type EventorOrganisation } from "../eventor.js";

const ORG: EventorOrganisation = { id: 321, name: "Test IF" };
const PROD_KEY = "eventor_api_key";
const TEST_KEY = "eventor_api_key_test";

function makeDeps(initialDb: Record<string, string | null> = {}): {
  deps: KeyStoreDeps;
  db: Map<string, string | null>;
  getSetting: ReturnType<typeof vi.fn>;
  setSetting: ReturnType<typeof vi.fn>;
  validateApiKey: ReturnType<typeof vi.fn>;
} {
  const db = new Map<string, string | null>(Object.entries(initialDb));
  const getSetting = vi.fn(async (key: string) => db.get(key) ?? null);
  const setSetting = vi.fn(async (key: string, value: string | null) => {
    if (value === null) db.delete(key);
    else db.set(key, value);
  });
  const validateApiKey = vi.fn(async () => ORG);
  return {
    deps: { getSetting, setSetting, validateApiKey },
    db,
    getSetting,
    setSetting,
    validateApiKey,
  };
}

describe("eventorKeyStore", () => {
  describe("getKey (no Eventor round-trip)", () => {
    it("returns the persisted key without contacting Eventor", async () => {
      const { deps, validateApiKey } = makeDeps({ [PROD_KEY]: "abc123" });
      const store = createEventorKeyStore(deps);

      expect(await store.getKey("prod")).toBe("abc123");
      expect(validateApiKey).not.toHaveBeenCalled();
    });

    it("returns null when no key is persisted", async () => {
      const { deps } = makeDeps();
      const store = createEventorKeyStore(deps);

      expect(await store.getKey("prod")).toBeNull();
    });

    it("treats prod and test environments independently", async () => {
      const { deps } = makeDeps({
        [PROD_KEY]: "prod-key",
        [TEST_KEY]: "test-key",
      });
      const store = createEventorKeyStore(deps);

      expect(await store.getKey("prod")).toBe("prod-key");
      expect(await store.getKey("test")).toBe("test-key");
    });

    it("only reads the DB once across many calls", async () => {
      const { deps, getSetting } = makeDeps({ [PROD_KEY]: "abc123" });
      const store = createEventorKeyStore(deps);

      await store.getKey("prod");
      await store.getKey("prod");
      await store.getKey("prod");

      expect(getSetting).toHaveBeenCalledTimes(1);
    });

    it("coalesces concurrent loads into a single DB read", async () => {
      const { deps, getSetting } = makeDeps({ [PROD_KEY]: "abc123" });
      const store = createEventorKeyStore(deps);

      const [a, b, c] = await Promise.all([
        store.getKey("prod"),
        store.getKey("prod"),
        store.getKey("prod"),
      ]);

      expect(a).toBe("abc123");
      expect(b).toBe("abc123");
      expect(c).toBe("abc123");
      expect(getSetting).toHaveBeenCalledTimes(1);
    });

    it("retries the DB read after a transient failure (does not latch)", async () => {
      const { db, deps, getSetting } = makeDeps();
      db.set(PROD_KEY, "abc123");
      // First call throws (DB hiccup), second succeeds.
      getSetting.mockImplementationOnce(async () => {
        throw new Error("MySQL connection refused");
      });
      const store = createEventorKeyStore(deps);

      await expect(store.getKey("prod")).rejects.toThrow("MySQL connection refused");
      // The bug: previously the latch was set BEFORE the load, so a transient
      // DB error would permanently mark the key as "unconfigured". Verify
      // that's no longer the case — the next call must retry and find it.
      expect(await store.getKey("prod")).toBe("abc123");
      expect(getSetting).toHaveBeenCalledTimes(2);
    });
  });

  describe("setKey", () => {
    it("validates against Eventor and persists on success", async () => {
      const { deps, db, validateApiKey, setSetting } = makeDeps();
      const store = createEventorKeyStore(deps);

      const org = await store.setKey("new-key", "prod");

      expect(org).toEqual(ORG);
      expect(validateApiKey).toHaveBeenCalledWith("new-key", "prod");
      expect(setSetting).toHaveBeenCalledWith(PROD_KEY, "new-key");
      expect(db.get(PROD_KEY)).toBe("new-key");
      expect(await store.getKey("prod")).toBe("new-key");
    });

    it("does not persist when Eventor rejects the key", async () => {
      const { deps, db, setSetting, validateApiKey } = makeDeps();
      validateApiKey.mockRejectedValueOnce(new EventorAuthError());
      const store = createEventorKeyStore(deps);

      await expect(store.setKey("bad-key", "prod")).rejects.toBeInstanceOf(
        EventorAuthError,
      );
      expect(setSetting).not.toHaveBeenCalled();
      expect(db.has(PROD_KEY)).toBe(false);
    });

    it("uses the test setting key for env=test", async () => {
      const { deps, db } = makeDeps();
      const store = createEventorKeyStore(deps);

      await store.setKey("t-key", "test");

      expect(db.get(TEST_KEY)).toBe("t-key");
      expect(db.has(PROD_KEY)).toBe(false);
    });
  });

  describe("getKeyWithOrg", () => {
    it("returns cached org info without re-validating", async () => {
      const { deps, validateApiKey } = makeDeps();
      const store = createEventorKeyStore(deps);
      await store.setKey("abc", "prod");
      validateApiKey.mockClear();

      const result = await store.getKeyWithOrg("prod");

      expect(result).toEqual({ apiKey: "abc", org: ORG });
      expect(validateApiKey).not.toHaveBeenCalled();
    });

    it("populates org info from Eventor on first call after restart", async () => {
      const { deps, validateApiKey } = makeDeps({ [PROD_KEY]: "abc" });
      const store = createEventorKeyStore(deps);

      const result = await store.getKeyWithOrg("prod");

      expect(result).toEqual({ apiKey: "abc", org: ORG });
      expect(validateApiKey).toHaveBeenCalledTimes(1);

      // Subsequent calls should reuse the cached org.
      await store.getKeyWithOrg("prod");
      expect(validateApiKey).toHaveBeenCalledTimes(1);
    });

    it("preserves the persisted key when Eventor returns 403", async () => {
      // Regression: a single 403 from Eventor (which can be transient!) must
      // never wipe the user's saved key. Manually re-entering the key after
      // each flaky Eventor response is a much worse experience than a brief
      // error message until Eventor recovers.
      const { deps, db, validateApiKey, setSetting } = makeDeps({
        [PROD_KEY]: "good-but-rejected",
      });
      validateApiKey.mockRejectedValueOnce(new EventorAuthError());
      const store = createEventorKeyStore(deps);

      await expect(store.getKeyWithOrg("prod")).rejects.toBeInstanceOf(
        EventorAuthError,
      );

      // The DB row must remain intact — only an explicit clearKey() should
      // ever delete it.
      expect(setSetting).not.toHaveBeenCalled();
      expect(db.get(PROD_KEY)).toBe("good-but-rejected");
      expect(await store.getKey("prod")).toBe("good-but-rejected");

      // Subsequent calls retry validation against Eventor — if the 403 was
      // transient, recovery is automatic.
      validateApiKey.mockResolvedValueOnce(ORG);
      const result = await store.getKeyWithOrg("prod");
      expect(result).toEqual({ apiKey: "good-but-rejected", org: ORG });
    });

    it("preserves the persisted key on transient Eventor failures", async () => {
      const { deps, db, validateApiKey, setSetting } = makeDeps({
        [PROD_KEY]: "good",
      });
      validateApiKey.mockRejectedValueOnce(new Error("ETIMEDOUT"));
      const store = createEventorKeyStore(deps);

      await expect(store.getKeyWithOrg("prod")).rejects.toThrow("ETIMEDOUT");

      // Critical regression: Eventor being slow/unreachable must NOT cause
      // the user to lose their saved key.
      expect(setSetting).not.toHaveBeenCalled();
      expect(db.get(PROD_KEY)).toBe("good");
      expect(await store.getKey("prod")).toBe("good");

      // Next call should retry validation, since org is still uncached.
      validateApiKey.mockResolvedValueOnce(ORG);
      const result = await store.getKeyWithOrg("prod");
      expect(result).toEqual({ apiKey: "good", org: ORG });
    });

    it("returns null when no key is persisted", async () => {
      const { deps } = makeDeps();
      const store = createEventorKeyStore(deps);

      expect(await store.getKeyWithOrg("prod")).toBeNull();
    });
  });

  describe("clearKey", () => {
    it("removes the key from memory and the DB", async () => {
      const { deps, db } = makeDeps({ [PROD_KEY]: "abc" });
      const store = createEventorKeyStore(deps);
      await store.getKey("prod"); // load into cache

      await store.clearKey("prod");

      expect(db.has(PROD_KEY)).toBe(false);
      expect(await store.getKey("prod")).toBeNull();
    });
  });

  describe("peek", () => {
    let store: ReturnType<typeof createEventorKeyStore>;

    beforeEach(async () => {
      const { deps } = makeDeps({ [PROD_KEY]: "abc" });
      store = createEventorKeyStore(deps);
    });

    it("returns null before the key is loaded", () => {
      expect(store.peek("prod")).toBeNull();
    });

    it("returns the cached entry once loaded", async () => {
      await store.getKey("prod");
      expect(store.peek("prod")).toEqual({ apiKey: "abc" });
    });
  });
});
