import type { ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../context/CurrentUserContext";

/**
 * Identity-less kiosk / start-screen devices must present `?k=` when
 * AUTH_MODE is on. Logged-in users (e.g. an admin opening the kiosk
 * from the shell) skip the key.
 */
export function KioskAccessGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation("kiosk");
  const { user, authEnabled, isLoading } = useCurrentUser();
  const [params] = useSearchParams();
  const kioskKey = params.get("k")?.trim() ?? "";

  if (!authEnabled) return children;
  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="inline-block w-8 h-8 border-4 border-slate-600 border-t-white rounded-full animate-spin" />
      </div>
    );
  }
  if (user || kioskKey) return children;

  return (
    <div
      data-testid="kiosk-key-required"
      className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-8"
    >
      <p className="max-w-md text-center text-lg">{t("kioskKeyRequired")}</p>
    </div>
  );
}
