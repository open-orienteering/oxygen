import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { trpc } from "../lib/trpc";
import {
  attemptSessionReload,
  isNetworkClassError,
} from "../lib/session-recovery";
import { probeSession, type ProbeResult } from "../lib/session-probe";
import { getActiveBaseUrl } from "../lib/node-discovery";
import { canReloadBounded } from "../lib/error-recovery";
import {
  loadLastIdentity,
  resolveCurrentUser,
  saveLastIdentity,
  type Identity,
} from "../lib/current-user-state";

export type CurrentUser = {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
};

/** "expired": the probe saw a sign-in redirect; "unreachable": no answer, nothing to reload for. */
export type SessionState = "ok" | ProbeResult;

type CurrentUserValue = {
  user: CurrentUser | null;
  identityEmail: string | null;
  authEnabled: boolean;
  isLoading: boolean;
  /** Running on the last known identity while `users.me` cannot be reached. */
  degraded: boolean;
  sessionState: SessionState;
};

const CurrentUserContext = createContext<CurrentUserValue | null>(null);

function hasTrpcCode(err: unknown): boolean {
  const code = (err as { data?: { code?: unknown } | null } | null)?.data?.code;
  return typeof code === "string" && code.length > 0;
}

const AUTO_RELOAD_KEY = "oxygen.sessionRecovery.autoReloads";

function sessionStore(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** While `users.me` is failing it is retried this often (on top of online / focus refetches). */
const ERROR_REFETCH_MS = 15_000;

export function CurrentUserProvider({ children }: { children: ReactNode }) {
  const me = trpc.users.me.useQuery(undefined, {
    staleTime: 60_000,
    retry: 1,
    refetchInterval: (q) => (q.state.status === "error" ? ERROR_REFETCH_MS : false),
  });
  // No answer from our API: a network-class failure, or an error without
  // a tRPC code (the bundled nginx answers 502/504 with its own JSON).
  const networkClass = me.isError && (isNetworkClassError(me.error) || !hasTrpcCode(me.error));
  const [lastKnown, setLastKnown] = useState<Identity | null>(() => loadLastIdentity());
  const [sessionState, setSessionState] = useState<SessionState>("ok");
  const refetchedAfterOkProbe = useRef(false);

  useEffect(() => {
    if (!me.data) return;
    const identity: Identity = {
      authEnabled: me.data.authEnabled,
      user: me.data.user ?? null,
      identityEmail: me.data.identityEmail ?? null,
    };
    saveLastIdentity(identity);
    setLastKnown(identity);
  }, [me.data]);

  const resolved = resolveCurrentUser({
    data: me.data
      ? { authEnabled: me.data.authEnabled, user: me.data.user ?? null, identityEmail: me.data.identityEmail ?? null }
      : undefined,
    isLoading: me.isLoading,
    networkClass,
    lastKnown,
  });
  const nothingMounted = resolved.isLoading;
  const nothingMountedRef = useRef(nothingMounted);
  nothingMountedRef.current = nothingMounted;

  // Each network-class failure of `users.me`: unreachable server, or an
  // expired IAP session? Only the second is fixed by a reload, and only a
  // page with nothing open reloads by itself (WEB-04); a station in use
  // gets a banner instead.
  useEffect(() => {
    if (!networkClass) {
      setSessionState("ok");
      refetchedAfterOkProbe.current = false;
      return;
    }
    let cancelled = false;
    void probeSession(fetch, getActiveBaseUrl()).then((result) => {
      if (cancelled) return;
      if (result === "ok") {
        // The server answers: the failure was transient. Ask once more now
        // rather than waiting for the interval.
        setSessionState("ok");
        if (!refetchedAfterOkProbe.current) {
          refetchedAfterOkProbe.current = true;
          void me.refetch();
        }
        return;
      }
      setSessionState(result);
      // Bounded (two per five minutes): a reload that does not fix the
      // session must not turn into a reload every 15 s.
      // The public kiosk / start screen is in use even while nothing is
      // known: it never reloads by itself.
      const publicSurface = /^\/[^/]+\/(kiosk|start-screen)(\/|$)/.test(window.location.pathname);
      if (result === "expired" && nothingMountedRef.current && !publicSurface && canReloadBounded(AUTO_RELOAD_KEY, sessionStore())) {
        attemptSessionReload();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [networkClass, me.errorUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const value: CurrentUserValue = {
    user: resolved.user,
    identityEmail: resolved.identityEmail,
    authEnabled: resolved.authEnabled,
    isLoading: resolved.isLoading,
    degraded: resolved.degraded,
    sessionState,
  };
  return (
    <CurrentUserContext.Provider value={value}>
      {children}
    </CurrentUserContext.Provider>
  );
}

export function useCurrentUser(): CurrentUserValue {
  const ctx = useContext(CurrentUserContext);
  if (!ctx) {
    throw new Error("useCurrentUser must be used within CurrentUserProvider");
  }
  return ctx;
}
