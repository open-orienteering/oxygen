/**
 * What `CurrentUserProvider` tells the app while `users.me` is failing
 * (WEB-04). A background refetch that fails on the network must not
 * replace the app with a spinner: the shell, an open station page and a
 * half-filled registration would unmount. The last known identity, from
 * the query or from local storage after a reload, keeps the app mounted.
 */

export interface Identity {
  authEnabled: boolean;
  user: { id: string; email: string; displayName: string; isAdmin: boolean } | null;
  identityEmail: string | null;
}

export interface ResolvedUser {
  user: Identity["user"];
  identityEmail: string | null;
  authEnabled: boolean;
  /** Nothing is known yet: the access gate shows a spinner. */
  isLoading: boolean;
  /** Running on a remembered identity because `users.me` cannot be reached. */
  degraded: boolean;
}

export function resolveCurrentUser({
  data,
  isLoading,
  networkClass,
  lastKnown,
}: {
  data: Identity | undefined;
  isLoading: boolean;
  /** The query failed with a network-class error (no server answer). */
  networkClass: boolean;
  lastKnown: Identity | null;
}): ResolvedUser {
  const identity = data ?? (networkClass ? lastKnown : null) ?? null;
  return {
    user: identity?.user ?? null,
    identityEmail: identity?.identityEmail ?? null,
    // A network-class failure with nothing known must not flip auth off:
    // that skips the access gate (bugfixes/pwa-iap-session-recovery.md).
    authEnabled: identity?.authEnabled ?? (networkClass ? true : false),
    isLoading: !identity && (isLoading || networkClass),
    degraded: networkClass && !!identity,
  };
}

const LAST_IDENTITY_KEY = "oxygen.lastIdentity";

type KV = Pick<Storage, "getItem" | "setItem">;
const defaultStorage = (): KV | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function loadLastIdentity(storage: KV | null = defaultStorage()): Identity | null {
  try {
    const raw = storage?.getItem(LAST_IDENTITY_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Identity>;
    if (typeof v.authEnabled !== "boolean") return null;
    return { authEnabled: v.authEnabled, user: v.user ?? null, identityEmail: v.identityEmail ?? null };
  } catch {
    return null;
  }
}

export function saveLastIdentity(identity: Identity, storage: KV | null = defaultStorage()): void {
  try {
    storage?.setItem(
      LAST_IDENTITY_KEY,
      JSON.stringify({ authEnabled: identity.authEnabled, user: identity.user, identityEmail: identity.identityEmail }),
    );
  } catch {
    // Private mode, quota: the identity is then only kept in memory.
  }
}
