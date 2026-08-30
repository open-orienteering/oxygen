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
    loaded: q.isSuccess,
    has: (cap) => !q.isSuccess || (capabilities?.has(cap) ?? false),
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
