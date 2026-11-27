import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Capability } from "@oxygen/shared";
import { trpc } from "../lib/trpc";

type CapabilitiesValue = {
  capabilities: ReadonlySet<Capability> | null;
  loaded: boolean;
  has: (cap: Capability) => boolean;
};

const CapabilitiesContext = createContext<CapabilitiesValue | null>(null);

export function CapabilitiesProvider({ children }: { children: ReactNode }) {
  const q = trpc.permission.myCapabilities.useQuery(undefined, {
    staleTime: 30_000,
  });
  const capabilities = useMemo(
    () => (q.data ? new Set(q.data) : null),
    [q.data],
  );
  const value: CapabilitiesValue = {
    capabilities,
    loaded: capabilities !== null,
    // Fails open only while nothing is known (the server checks anyway). A
    // failed refetch keeps the last answer: during an outage the cached
    // capabilities still decide, not "everything allowed" (WEB-03).
    has: (cap) => (capabilities ? capabilities.has(cap) : true),
  };
  return (
    <CapabilitiesContext.Provider value={value}>
      {children}
    </CapabilitiesContext.Provider>
  );
}

export function useCapabilities(): CapabilitiesValue {
  const ctx = useContext(CapabilitiesContext);
  if (!ctx) {
    throw new Error("useCapabilities must be used within CapabilitiesProvider");
  }
  return ctx;
}
