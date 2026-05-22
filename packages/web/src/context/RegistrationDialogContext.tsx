/**
 * Registration dialog context. Manages the global "register a new
 * runner" dialog (used by the card-notification banner and operator
 * actions). The dialog body lives in `components/RegistrationDialog.tsx`;
 * this provider owns the open/close state, the recent-registration
 * banner queue, and the sticky-mode toggle so the kiosk can keep the
 * dialog up across consecutive readouts.
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
interface RecentRegistration {
  name: string;
  className: string;
  clubName: string;
  startTime: string;
  cardNo: number;
  timestamp: Date;
}

interface PendingCard {
  cardNo: number;
  ownerData?: Record<string, string> | null;
}

interface RegistrationDialogState {
  isOpen: boolean;
  stickyMode: boolean;
  pendingCard: PendingCard | null;
  recentRegistrations: RecentRegistration[];
  openRegistration: (
    cardNo?: number,
    ownerData?: Record<string, string> | null,
  ) => void;
  closeRegistration: () => void;
  toggleStickyMode: () => void;
  addRecentRegistration: (entry: RecentRegistration) => void;
}

const STICKY_KEY = "oxygen-sticky-registration";

const ctx = createContext<RegistrationDialogState | null>(null);

export function RegistrationDialogProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [stickyMode, setStickyMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STICKY_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [pendingCard, setPendingCard] = useState<PendingCard | null>(null);
  const [recentRegistrations, setRecentRegistrations] = useState<
    RecentRegistration[]
  >([]);

  const openRegistration = useCallback(
    (cardNo?: number, ownerData?: Record<string, string> | null) => {
      setPendingCard(cardNo ? { cardNo, ownerData: ownerData ?? null } : null);
      setIsOpen(true);
    },
    [],
  );
  const closeRegistration = useCallback(() => {
    setIsOpen(false);
    setPendingCard(null);
  }, []);
  const toggleStickyMode = useCallback(() => {
    setStickyMode((v) => {
      const next = !v;
      try {
        localStorage.setItem(STICKY_KEY, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  const addRecentRegistration = useCallback((entry: RecentRegistration) => {
    setRecentRegistrations((prev) => [entry, ...prev].slice(0, 10));
  }, []);

  const value: RegistrationDialogState = {
    isOpen,
    stickyMode,
    pendingCard,
    recentRegistrations,
    openRegistration,
    closeRegistration,
    toggleStickyMode,
    addRecentRegistration,
  };

  return <ctx.Provider value={value}>{children}</ctx.Provider>;
}

export function useRegistrationDialog(): RegistrationDialogState {
  const v = useContext(ctx);
  if (!v) {
    throw new Error(
      "useRegistrationDialog must be used inside RegistrationDialogProvider",
    );
  }
  return v;
}
