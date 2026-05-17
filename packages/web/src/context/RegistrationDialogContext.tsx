/**
 * Registration dialog context — being re-ported. Provides the
 * open/close API the rest of the app relies on; the dialog body
 * itself is stubbed during the post-MeOS migration.
 */

import { createContext, useContext, useState, type ReactNode } from "react";
import { RegistrationDialog } from "../components/RegistrationDialog";

interface OpenOptions {
  initialCardNo?: number;
}

interface ContextValue {
  open: boolean;
  openRegistration: (opts?: OpenOptions) => void;
  closeRegistration: () => void;
}

const ctx = createContext<ContextValue | null>(null);

export function RegistrationDialogProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [initialCardNo, setInitialCardNo] = useState<number | undefined>(undefined);
  const value: ContextValue = {
    open,
    openRegistration: (opts) => {
      setInitialCardNo(opts?.initialCardNo);
      setOpen(true);
    },
    closeRegistration: () => setOpen(false),
  };
  return (
    <ctx.Provider value={value}>
      {children}
      {open && (
        <RegistrationDialog
          onClose={() => setOpen(false)}
          initialCardNo={initialCardNo}
        />
      )}
    </ctx.Provider>
  );
}

export function useRegistrationDialog(): ContextValue {
  const v = useContext(ctx);
  if (!v) {
    throw new Error(
      "useRegistrationDialog must be used inside RegistrationDialogProvider",
    );
  }
  return v;
}
