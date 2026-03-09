import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import { useDeviceManager, type RecentCard } from "./DeviceManager";

interface RecentRegistration {
  name: string;
  className: string;
  clubName: string;
  startTime: string;
  cardNo: number;
  timestamp: Date;
}

interface RegistrationDialogState {
  isOpen: boolean;
  stickyMode: boolean;
  /** Card number + owner data to pre-fill when dialog opens */
  pendingCard: { cardNo: number; ownerData?: Record<string, string> | null } | null;
  recentRegistrations: RecentRegistration[];
  openRegistration: (cardNo?: number, ownerData?: Record<string, string> | null) => void;
  closeRegistration: () => void;
  toggleStickyMode: () => void;
  addRecentRegistration: (entry: RecentRegistration) => void;
}

const RegistrationDialogContext = createContext<RegistrationDialogState | null>(null);

export function useRegistrationDialog(): RegistrationDialogState {
  const ctx = useContext(RegistrationDialogContext);
  if (!ctx) throw new Error("useRegistrationDialog must be used within RegistrationDialogProvider");
  return ctx;
}

const STICKY_KEY = "oxygen-sticky-registration";

export function RegistrationDialogProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [stickyMode, setStickyMode] = useState(() => {
    try { return localStorage.getItem(STICKY_KEY) === "true"; } catch { return false; }
  });
  const [pendingCard, setPendingCard] = useState<RegistrationDialogState["pendingCard"]>(null);
  const [recentRegistrations, setRecentRegistrations] = useState<RecentRegistration[]>([]);

  const { currentCard } = useDeviceManager();

  // Track last consumed card to avoid re-filling the same card
  const lastConsumedCardRef = useRef<string | null>(null);

  // When dialog is open + sticky mode + new register card arrives → update pendingCard
  useEffect(() => {
    if (!isOpen || !stickyMode) return;
    if (!currentCard || currentCard.action !== "register" || !currentCard.actionResolved) return;
    if (lastConsumedCardRef.current === currentCard.id) return;
    lastConsumedCardRef.current = currentCard.id;
    setPendingCard({
      cardNo: currentCard.cardNumber,
      ownerData: currentCard.ownerData ? {
        firstName: (currentCard.ownerData as any).firstName,
        lastName: (currentCard.ownerData as any).lastName,
        club: (currentCard.ownerData as any).club,
        sex: (currentCard.ownerData as any).sex,
        dateOfBirth: (currentCard.ownerData as any).dateOfBirth,
        phone: (currentCard.ownerData as any).phone,
      } : null,
    });
  }, [isOpen, stickyMode, currentCard]);

  const openRegistration = useCallback((cardNo?: number, ownerData?: Record<string, string> | null) => {
    setPendingCard(cardNo ? { cardNo, ownerData: ownerData ?? null } : null);
    if (cardNo && currentCard?.id) {
      lastConsumedCardRef.current = currentCard.id;
    }
    setIsOpen(true);
  }, [currentCard]);

  const closeRegistration = useCallback(() => {
    setIsOpen(false);
    setPendingCard(null);
  }, []);

  const toggleStickyMode = useCallback(() => {
    setStickyMode((prev) => {
      const next = !prev;
      try { localStorage.setItem(STICKY_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const addRecentRegistration = useCallback((entry: RecentRegistration) => {
    setRecentRegistrations((prev) => [entry, ...prev.slice(0, 19)]);
  }, []);

  return (
    <RegistrationDialogContext.Provider
      value={{
        isOpen,
        stickyMode,
        pendingCard,
        recentRegistrations,
        openRegistration,
        closeRegistration,
        toggleStickyMode,
        addRecentRegistration,
      }}
    >
      {children}
    </RegistrationDialogContext.Provider>
  );
}
