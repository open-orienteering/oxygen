import { createContext, useContext, type ReactNode } from "react";
import { trpc } from "../lib/trpc";

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
  const me = trpc.users.me.useQuery(undefined, { staleTime: 60_000 });
  const value: CurrentUserValue = {
    user: me.data?.user ?? null,
    identityEmail: me.data?.identityEmail ?? null,
    authEnabled: me.data?.authEnabled ?? false,
    isLoading: me.isLoading,
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
