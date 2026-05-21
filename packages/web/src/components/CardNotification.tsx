/**
 * Global notification banner for SI card reads.
 *
 * Shows a contextual slide-down banner depending on the card state:
 * - "register"  — unknown card → "Register Runner?" button
 * - "readout"   — known runner with race data → "View Readout" button
 * - "pre-start" — known runner, clean card → "View Start" button
 *
 * Auto-dismisses after 10 seconds. Suppressed on the Card Readout page.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useLocation } from "react-router-dom";
import { useDeviceManager, type RecentCard } from "../context/DeviceManager";
import { useRegistrationDialog } from "../context/RegistrationDialogContext";
import { formatRunningTime } from "@oxygen/shared";

const AUTO_DISMISS_MS = 10000;

export function CardNotification() {
  const { t } = useTranslation("race");
  const { currentCard, isOnCardReadoutPage } = useDeviceManager();
  const navigate = useNavigate();
  const location = useLocation();
  const { openRegistration } = useRegistrationDialog();

  const [visible, setVisible] = useState(false);
  const [card, setCard] = useState<RecentCard | null>(null);
  const timerRef = useRef<any>(undefined);

  const onCardPage = location.pathname.includes("/card-readout");

  useEffect(() => {
    if (!currentCard || onCardPage || isOnCardReadoutPage) return;

    setCard(currentCard);
    setVisible(true);

    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setVisible(false), AUTO_DISMISS_MS);

    return () => clearTimeout(timerRef.current);
  }, [currentCard, onCardPage, isOnCardReadoutPage]);

  // Update card details in real-time (e.g. after runner resolution)
  useEffect(() => {
    if (currentCard && card && currentCard.id === card.id) {
      setCard(currentCard);
    }
  }, [currentCard, card]);

  if (!visible || !card) return null;

  const base = location.pathname.split("/").slice(0, 2).join("/");

  const handleAction = () => {
    setVisible(false);
    clearTimeout(timerRef.current);
    switch (card.action) {
      case "readout":
        navigate(`${base}/card-readout?card=${card.cardNumber}`);
        break;
      case "register": {
        const ownerData: Record<string, string> = {};
        if (card.ownerData?.firstName) ownerData.firstName = card.ownerData.firstName;
        if (card.ownerData?.lastName) ownerData.lastName = card.ownerData.lastName;
        if (card.ownerData?.club) ownerData.club = card.ownerData.club;
        if (card.ownerData?.sex) ownerData.sex = card.ownerData.sex;
        if (card.ownerData?.dateOfBirth) ownerData.dateOfBirth = card.ownerData.dateOfBirth;
        if (card.ownerData?.phone) ownerData.phone = card.ownerData.phone;
        openRegistration(card.cardNumber, Object.keys(ownerData).length > 0 ? ownerData : null);
        break;
      }
      case "pre-start":
        navigate(`${base}/start-station?card=${card.cardNumber}`);
        break;
    }
  };

  const handleDismiss = () => {
    setVisible(false);
    clearTimeout(timerRef.current);
  };

  // ── Banner color + content by action ─────────────────────

  let bgColor: string;
  let iconPath: string;
  let actionLabel: string;
  let content: React.ReactNode;

  switch (card.action) {
    case "register": {
      bgColor = "bg-amber-600";
      iconPath = "M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z";
      actionLabel = t("notifRegister");
      const ownerName = card.ownerData
        ? [card.ownerData.firstName, card.ownerData.lastName]
          .filter(Boolean)
          .join(" ")
        : "";
      content = (
        <>
          <span className="font-semibold">{t("notifNewCard", { card: card.cardNumber })}</span>
          {ownerName ? (
            <span className="ml-2">
              {ownerName}
              {card.ownerData?.club && (
                <span className="opacity-75">, {card.ownerData.club}</span>
              )}
              <span className="ml-1 opacity-80">— {t("notifNotRegistered")}</span>
            </span>
          ) : (
            <span className="ml-2 opacity-80">— {t("notifNotRegisteredInComp")}</span>
          )}
        </>
      );
      break;
    }

    case "pre-start":
      bgColor = "bg-emerald-600";
      iconPath = "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z";
      actionLabel = t("notifViewStart");
      content = (
        <>
          <span className="font-semibold">{t("notifCard", { card: card.cardNumber })}</span>
          {card.runnerName && (
            <span className="ml-2">
              {card.runnerName}
              {card.className && (
                <span className="opacity-75">, {card.className}</span>
              )}
            </span>
          )}
          <span className="ml-2 opacity-80">— {t("notifReadyToStart")}</span>
        </>
      );
      break;

    case "readout":
    default:
      bgColor = card.isRentalCard ? "bg-amber-600" : "bg-blue-600";
      iconPath = "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z";
      actionLabel = t("notifViewReadout");
      content = (
        <>
          <span className="font-semibold">{t("notifCard", { card: card.cardNumber })}</span>
          {card.runnerName ? (
            <span className="ml-2">
              {card.runnerName}
              {card.className && (
                <span className="opacity-75">, {card.className}</span>
              )}
              {card.runningTime != null && card.runningTime > 0 && (
                <span className="ml-2 font-mono">
                  {formatRunningTime(card.runningTime)}
                </span>
              )}
              {card.status && (
                <span
                  className={`ml-2 font-bold ${card.status === "OK"
                      ? "text-emerald-200"
                      : card.status === "MP"
                        ? "text-red-200"
                        : "text-amber-200"
                    }`}
                >
                  {card.status}
                </span>
              )}
            </span>
          ) : (
            <span className="ml-2 opacity-75">{t("notifReading")}</span>
          )}
          {card.isRentalCard && (
            <span className="ml-3 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-white/20">
              {t("notifReturnCard")}
            </span>
          )}
        </>
      );
      break;
  }

  return (
    <div
      className={`${bgColor} text-white px-4 py-3 shadow-lg animate-slide-down`}
      data-testid="card-notification"
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`shrink-0 w-8 h-8 ${bgColor} brightness-90 rounded-lg flex items-center justify-center`}>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={iconPath} />
            </svg>
          </div>
          <div className="truncate text-sm">{content}</div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleAction}
            className="px-3 py-1.5 text-sm font-medium bg-white/90 text-slate-800 rounded-lg hover:bg-white transition-colors cursor-pointer"
            data-testid="card-notification-view"
          >
            {actionLabel}
          </button>
          <button
            onClick={handleDismiss}
            className="p-1 text-white/70 hover:text-white transition-colors cursor-pointer"
            aria-label="Dismiss"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
