import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { trpc } from "../lib/trpc";
import {
  attemptSessionReload,
  isNetworkClassError,
} from "../lib/session-recovery";

export type CurrentUser = {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
};

type CurrentUserValue = {
  user: CurrentUser | null;
  identityEmail: string | null;
  authEnabled: boolean;
  isLoading: boolean;
};

const CurrentUserContext = createContext<CurrentUserValue | null>(null);

export function CurrentUserProvider({ children }: { children: ReactNode }) {
  const me = trpc.users.me.useQuery(undefined, { staleTime: 60_000, retry: 1 });
  const networkClass = me.isError && isNetworkClassError(me.error);
  const recoveryStarted = useRef(false);

  // Expired IAP sessions fail `users.me` as a CORS "Failed to fetch". Do not
  // treat that as authEnabled=false (which skips the access gate); keep the
  // UI in a loading state and attempt a guarded full reload so the cookie
  // can refresh.
  useEffect(() => {
    if (!networkClass || !navigator.onLine) return;
    if (recoveryStarted.current) return;
    recoveryStarted.current = true;
    const timer = window.setTimeout(() => {
      void me.refetch().then((result) => {
        if (result.error && isNetworkClassError(result.error)) {
          attemptSessionReload();
        }
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [networkClass]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!networkClass) recoveryStarted.current = false;
  }, [networkClass]);

  const value: CurrentUserValue = {
    user: me.data?.user ?? null,
    identityEmail: me.data?.identityEmail ?? null,
    // Network-class failures must not silently flip auth off — that skips
    // AccessDenied and lets CompetitionShell mis-report "Event not found".
    authEnabled: networkClass
      ? (me.data?.authEnabled ?? true)
      : (me.data?.authEnabled ?? false),
    isLoading: me.isLoading || networkClass,
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
