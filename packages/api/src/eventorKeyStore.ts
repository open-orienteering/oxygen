/**
 * Persistent + in-memory store for Eventor API keys, one per environment.
 *
 * Design goals (these all directly fix the "key keeps being forgotten" bug):
 *
 * 1. The DB row in `oxygen_settings` is the source of truth. The in-memory
 *    cache is a pure performance optimisation.
 *
 * 2. We never delete the persisted key automatically. Only the explicit
 *    "Clear" action in the UI removes the row from the database. A 403 from
 *    Eventor on lazy validation invalidates the in-memory org cache and
 *    propagates the error to the caller, but the saved key stays put — a
 *    transient 403 must not cost the user their saved credentials, and even
 *    a definitive 403 is better surfaced as an error to the user than as a
 *    silent deletion they can't undo.
 *
 * 3. The "loaded from DB" latch is only set after a successful read. If the
 *    DB read itself throws, we leave the latch unset so the next request
 *    retries instead of pretending the key doesn't exist.
 *
 * 4. We do *not* validate the key against Eventor on load. Validation only
 *    happens when the user submits a new key, or lazily when a caller asks
 *    for the organisation info. A flaky Eventor instance during process
 *    startup must never cost the user their saved key.
 *
 * The store is dependency-injected (`KeyStoreDeps`) so it can be unit-tested
 * without a real database or Eventor backend.
 */

import { type EventorEnvironment } from "@oxygen/shared";
import {
  EventorAuthError,
  validateApiKey as defaultValidateApiKey,
  type EventorOrganisation,
} from "./eventor.js";
import { getSetting as defaultGetSetting, setSetting as defaultSetSetting } from "./db.js";

export interface KeyStoreDeps {
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string | null) => Promise<void>;
  validateApiKey: (
    apiKey: string,
    env: EventorEnvironment,
  ) => Promise<EventorOrganisation>;
}

interface StoredEntry {
  apiKey: string;
  /** Cached organisation info; populated lazily on first successful validation. */
  org?: EventorOrganisation;
}

const SETTING_KEYS: Record<EventorEnvironment, string> = {
  prod: "eventor_api_key",
  test: "eventor_api_key_test",
};

export function createEventorKeyStore(deps: KeyStoreDeps) {
  const cache = new Map<EventorEnvironment, StoredEntry | null>();
  const loaded = new Map<EventorEnvironment, boolean>();
  const inflightLoad = new Map<EventorEnvironment, Promise<void>>();

  async function loadFromDb(env: EventorEnvironment): Promise<void> {
    const saved = await deps.getSetting(SETTING_KEYS[env]);
    if (saved && saved.length > 0) {
      cache.set(env, { apiKey: saved });
    } else {
      cache.set(env, null);
    }
    // Only mark loaded after a successful DB read. If getSetting throws, we
    // leave `loaded` unset so the next call retries.
    loaded.set(env, true);
  }

  async function ensureLoaded(env: EventorEnvironment): Promise<void> {
    if (loaded.get(env)) return;

    // Coalesce concurrent loads so we don't hammer the DB on startup.
    let pending = inflightLoad.get(env);
    if (!pending) {
      pending = loadFromDb(env).finally(() => {
        inflightLoad.delete(env);
      });
      inflightLoad.set(env, pending);
    }
    await pending;
  }

  /**
   * Validate `apiKey` against Eventor and persist it on success. On 403 we
   * surface {@link EventorAuthError} to the caller and do *not* touch the
   * stored key. Any other error (network, 5xx, timeout, ...) propagates as-is.
   */
  async function setKey(
    apiKey: string,
    env: EventorEnvironment,
  ): Promise<EventorOrganisation> {
    const org = await deps.validateApiKey(apiKey, env);
    cache.set(env, { apiKey, org });
    loaded.set(env, true);
    await deps.setSetting(SETTING_KEYS[env], apiKey);
    return org;
  }

  /**
   * Explicitly remove the stored key, both in memory and in the DB.
   */
  async function clearKey(env: EventorEnvironment): Promise<void> {
    cache.set(env, null);
    loaded.set(env, true);
    await deps.setSetting(SETTING_KEYS[env], null);
  }

  /**
   * Get the stored API key (without contacting Eventor). Returns `null` if
   * none is configured. Throws if the underlying DB read fails — callers
   * surface this as a transient error rather than "no key configured".
   */
  async function getKey(env: EventorEnvironment): Promise<string | null> {
    await ensureLoaded(env);
    const entry = cache.get(env);
    return entry?.apiKey ?? null;
  }

  /**
   * Get the stored API key plus organisation info. If org info isn't cached,
   * we make a single Eventor round-trip to populate it.
   *
   * Errors (including {@link EventorAuthError}) propagate to the caller. We
   * never delete the persisted key here — Eventor 403s have empirically
   * been seen as transient blips during long-running processes, and silently
   * losing a working key is far worse than surfacing a transient error. The
   * user can clear the key explicitly via the Clear button if they really
   * want to discard it.
   */
  async function getKeyWithOrg(
    env: EventorEnvironment,
  ): Promise<{ apiKey: string; org: EventorOrganisation } | null> {
    await ensureLoaded(env);
    const entry = cache.get(env);
    if (!entry) return null;

    if (entry.org) {
      return { apiKey: entry.apiKey, org: entry.org };
    }

    const org = await deps.validateApiKey(entry.apiKey, env);
    cache.set(env, { apiKey: entry.apiKey, org });
    return { apiKey: entry.apiKey, org };
  }

  /**
   * Snapshot of in-memory state for the given env. Does not touch the DB.
   * Useful for `keyStatus`-style queries that should not block on DB I/O once
   * the key has been loaded. Callers that need fresh load semantics should
   * use {@link getKey} or {@link getKeyWithOrg} instead.
   */
  function peek(
    env: EventorEnvironment,
  ): { apiKey: string; org?: EventorOrganisation } | null {
    return cache.get(env) ?? null;
  }

  /**
   * Test-only: reset all in-memory state. Does not touch the DB.
   */
  function _resetForTests(): void {
    cache.clear();
    loaded.clear();
    inflightLoad.clear();
  }

  return {
    ensureLoaded,
    setKey,
    clearKey,
    getKey,
    getKeyWithOrg,
    peek,
    _resetForTests,
  };
}

export type EventorKeyStore = ReturnType<typeof createEventorKeyStore>;

/**
 * Default singleton wired up against the real DB and Eventor client. The
 * router uses this; tests construct their own store with stubbed deps.
 */
export const eventorKeyStore: EventorKeyStore = createEventorKeyStore({
  getSetting: defaultGetSetting,
  setSetting: defaultSetSetting,
  validateApiKey: defaultValidateApiKey,
});
