import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { parseMeosTime, formatMeosTime } from "@oxygen/shared";
import { SearchableSelect } from "./SearchableSelect";
import { ClubLogo } from "./ClubLogo";
import { useDeviceManager, type RecentCard } from "../context/DeviceManager";
import { useRegistrationDialog } from "../context/RegistrationDialogContext";
import { usePrinter } from "../context/PrinterContext";
import { fetchLogoRaster } from "../lib/receipt-printer/index.js";
import { getClubLogoUrl } from "../lib/club-logo";
import type { KioskChannel, RegistrationFormState } from "../lib/kiosk-channel";
import { fuzzyMatchClub } from "../lib/fuzzy-club-match";
import swishIcon from "../assets/swish-icon.svg";

export function RegistrationDialog() {
  const { t } = useTranslation("registration");
  const {
    isOpen,
    stickyMode,
    pendingCard,
    closeRegistration,
    toggleStickyMode,
    addRecentRegistration,
  } = useRegistrationDialog();
  const { recentCards, getKioskChannel } = useDeviceManager();
  const printer = usePrinter();
  const utils = trpc.useUtils();

  // ── Form state ──────────────────────────────────────────
  const [name, setName] = useState("");
  const [classId, setClassId] = useState<number>(0);
  const [clubId, setClubId] = useState<number>(0);
  const [cardNo, setCardNo] = useState("");
  const [startTime, setStartTime] = useState("");
  const [birthYear, setBirthYear] = useState("");
  const [sex, setSex] = useState("");
  const [phone, setPhone] = useState("");
  const [paymentMode, setPaymentMode] = useState<"billed" | "on-site" | "card" | "swish" | "cash" | "">("");
  const [isRentalCard, setIsRentalCard] = useState(false);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  // Autocomplete state
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestionIdx, setSelectedSuggestionIdx] = useState(-1);
  const [debouncedNameQuery, setDebouncedNameQuery] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const manualCardInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<any>(undefined);

  const lastConsumedCardRef = useRef<string | null>(null);
  const lastPendingCardRef = useRef<number | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const kioskChannelRef = useRef<KioskChannel | null>(null);
  const paymentDefaultApplied = useRef(false);
  const duplicatePrefilled = useRef<number>(0);

  // ── Queries ─────────────────────────────────────────────
  const classes = trpc.competition.dashboard.useQuery();
  const regConfig = trpc.competition.getRegistrationConfig.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });
  const cardFeeQuery = trpc.competition.getCardFee.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });
  const clubs = trpc.club.list.useQuery({ showAll: true });
  const syncStatus = trpc.eventor.syncStatus.useQuery();
  const env = syncStatus.data?.env || "prod";
  const keyStatus = trpc.eventor.keyStatus.useQuery({ env });

  // Eventor member lookup
  const selectedClub = clubs.data?.find((c) => c.id === clubId);
  const eventorOrgId = selectedClub?.extId || undefined;
  const ownOrgId = keyStatus.data && "organisationId" in keyStatus.data
    ? keyStatus.data.organisationId
    : undefined;
  const canFetchMembers = !!eventorOrgId && !!ownOrgId && eventorOrgId === ownOrgId;

  const clubMembers = trpc.eventor.clubMembers.useQuery(
    { organisationId: eventorOrgId!, env },
    { enabled: canFetchMembers, staleTime: 10 * 60_000, retry: false },
  );

  // Duplicate card check
  const cardNoNum = cardNo ? parseInt(cardNo, 10) : 0;
  const duplicateCheck = trpc.runner.findByCard.useQuery(
    { cardNo: cardNoNum },
    { enabled: cardNoNum > 0, staleTime: 5_000 },
  );

  // Card number lookup for auto-fill
  const cardLookup = trpc.eventor.lookupByCardNo.useQuery(
    { cardNo: cardNoNum },
    { enabled: cardNoNum > 0 && !name && duplicateCheck.isFetched && duplicateCheck.data === null, staleTime: 60_000, retry: false },
  );

  // Global runner DB search
  const globalSearch = trpc.eventor.searchRunnerDb.useQuery(
    { query: debouncedNameQuery },
    { enabled: debouncedNameQuery.length >= 2, staleTime: 30_000, retry: false },
  );

  // ── Derived ─────────────────────────────────────────────
  const selectedClubName = selectedClub?.name ?? "";
  const selectedClassName = classes.data?.classes.find((c) => c.id === classId)?.name ?? "";

  // ── Clear form ──────────────────────────────────────────
  const clearForm = useCallback(() => {
    setName("");
    setClassId(0);
    setClubId(0);
    setCardNo("");
    setStartTime("");
    setBirthYear("");
    setSex("");
    setPhone("");
    setError("");
    setSuccessMsg("");
    setIsRentalCard(false);
    setPaymentMode(regConfig.data?.paymentMethods.includes("billed") ? "billed" : regConfig.data?.paymentMethods[0] as typeof paymentMode || "");
    setShowSuggestions(false);
    setDebouncedNameQuery("");
    paymentDefaultApplied.current = false;
    duplicatePrefilled.current = 0;
  }, [regConfig.data]);

  const isFormDirty = !!(name || cardNo || classId || clubId || birthYear || sex || phone);

  // ── Kiosk channel ───────────────────────────────────────
  useEffect(() => {
    if (!isOpen) {
      kioskChannelRef.current = null;
      return;
    }
    const ch = getKioskChannel();
    kioskChannelRef.current = ch;
    return () => { kioskChannelRef.current = null; };
  }, [isOpen, getKioskChannel]);

  // Broadcast form state to kiosk
  const buildFormMessage = useCallback(() => {
    const classFee = classes.data?.classes.find((c) => c.id === classId)?.classFee ?? 0;
    const rentalFee = isRentalCard ? (cardFeeQuery.data?.cardFee ?? 0) : 0;
    const totalFee = classFee + rentalFee;
    const form: RegistrationFormState = {
      name,
      clubName: selectedClubName,
      className: selectedClassName,
      courseName: "",
      cardNo: cardNo ? parseInt(cardNo, 10) : 0,
      startTime,
      sex,
      birthYear,
      phone,
      paymentMode,
      fee: totalFee > 0 ? totalFee : undefined,
      swishNumber: regConfig.data?.swishNumber || undefined,
      clubEventorId: selectedClub?.extId || undefined,
      competitionName: classes.data?.competition?.name || undefined,
      isRentalCard: isRentalCard || undefined,
      cardFee: rentalFee > 0 ? rentalFee : undefined,
    };
    const ready = !!name.trim() && classId > 0;
    return { form, ready };
  }, [name, selectedClubName, selectedClassName, cardNo, startTime, sex, birthYear, phone, paymentMode, isRentalCard, classId, classes.data, regConfig.data, cardFeeQuery.data, selectedClub?.extId]);

  // Send on every form change
  useEffect(() => {
    if (!isOpen) return;
    const ch = kioskChannelRef.current;
    if (!ch || !cardNo || duplicateCheck.data) return;
    const { form, ready } = buildFormMessage();
    ch.send({ type: "registration-state", form, ready });
  }, [isOpen, buildFormMessage, cardNo, duplicateCheck.data]);

  // Heartbeat: re-send registration-state every 2s to keep kiosk watchdog alive
  const buildFormMessageRef = useRef(buildFormMessage);
  buildFormMessageRef.current = buildFormMessage;

  useEffect(() => {
    if (!isOpen) return;
    const ch = kioskChannelRef.current;
    if (!ch || !cardNo || duplicateCheck.data) return;
    const interval = setInterval(() => {
      const { form, ready } = buildFormMessageRef.current();
      ch.send({ type: "registration-state", form, ready });
    }, 2_000);
    return () => clearInterval(interval);
  }, [isOpen, cardNo, duplicateCheck.data]);

  // ── Pending card from context ───────────────────────────
  useEffect(() => {
    if (!isOpen || !pendingCard) return;
    if (lastPendingCardRef.current === pendingCard.cardNo) return;
    lastPendingCardRef.current = pendingCard.cardNo;

    // Clear and populate
    setName("");
    setClassId(0);
    setClubId(0);
    setStartTime("");
    setBirthYear("");
    setSex("");
    setPhone("");
    setError("");
    setSuccessMsg("");
    setShowSuggestions(false);
    setDebouncedNameQuery("");
    duplicatePrefilled.current = 0;

    setCardNo(String(pendingCard.cardNo));

    // Pre-fill from owner data
    if (pendingCard.ownerData) {
      const od = pendingCard.ownerData;
      const n = [od.firstName, od.lastName].filter(Boolean).join(" ");
      if (n) setName(n);
      if (od.dateOfBirth) setBirthYear(od.dateOfBirth.substring(0, 4));
      const rawSex = od.sex?.trim().toUpperCase() ?? "";
      if (rawSex.startsWith("M")) setSex("M");
      else if (rawSex.startsWith("F")) setSex("F");
      if (od.phone) setPhone(od.phone);
      if (od.club && clubs.data) {
        const match = fuzzyMatchClub(od.club, clubs.data);
        if (match) setClubId(match.id);
      }
      // Focus class selector if name is known
      if (n) {
        setTimeout(() => {
          const classBtn = document.querySelector<HTMLElement>('[data-testid="reg-class"] button');
          classBtn?.focus();
        }, 150);
      }
    }

    // Notify kiosk about the card
    const ch = kioskChannelRef.current;
    if (ch) {
      ch.send({
        type: "card-readout",
        card: {
          id: `reg-${pendingCard.cardNo}-${Date.now()}`,
          cardNumber: pendingCard.cardNo,
          cardType: "manual",
          action: "register" as const,
          hasRaceData: false,
        },
      });
    }
  }, [isOpen, pendingCard, clubs.data]);

  // ── Auto-fill from card lookup ──────────────────────────
  useEffect(() => {
    if (!isOpen || !cardLookup.data || name || duplicateCheck.data || duplicateCheck.isLoading) return;
    const r = cardLookup.data;
    if (r.name) {
      const parts = r.name.split(", ");
      const displayName = parts.length === 2 ? `${parts[1]} ${parts[0]}` : r.name;
      setName(displayName);
    }
    if (!birthYear && r.birthYear > 0) setBirthYear(String(r.birthYear));
    if (!sex && r.sex) setSex(r.sex);
    if (!clubId && r.clubEventorId && clubs.data) {
      const match = clubs.data.find((c) => c.extId === r.clubEventorId);
      if (match) setClubId(match.id);
    }
    setShowSuggestions(false);
    setDebouncedNameQuery("");
    setTimeout(() => {
      const classBtn = document.querySelector<HTMLElement>('[data-testid="reg-class"] button');
      classBtn?.focus();
    }, 150);
  }, [isOpen, cardLookup.data, clubs.data]);

  // ── Pre-fill from duplicate ─────────────────────────────
  useEffect(() => {
    if (!duplicateCheck.data) return;
    if (duplicatePrefilled.current === duplicateCheck.data.cardNo) return;
    duplicatePrefilled.current = duplicateCheck.data.cardNo;
    const d = duplicateCheck.data;
    setName(d.name);
    if (d.classId) setClassId(d.classId);
    if (d.clubId) setClubId(d.clubId);
    setShowSuggestions(false);
  }, [duplicateCheck.data]);

  // ── Auto-populate from DeviceManager card reads (sticky mode) ──
  useEffect(() => {
    if (!isOpen) return;
    if (recentCards.length === 0) return;
    const latest = recentCards[0];
    if (!latest.actionResolved) return;
    if (lastConsumedCardRef.current === latest.id) return;
    // Only consume register actions
    if (latest.action !== "register") return;
    lastConsumedCardRef.current = latest.id;

    // Only auto-fill if form is clean (sticky mode just cleared)
    if (isFormDirty) return;

    setCardNo(String(latest.cardNumber));
    if (latest.ownerData) {
      const od = latest.ownerData;
      const n = [od.firstName, od.lastName].filter(Boolean).join(" ");
      if (n) setName(n);
      if (od.dateOfBirth) setBirthYear((od.dateOfBirth as string).substring(0, 4));
      const rawSex = (od.sex as string)?.trim().toUpperCase() ?? "";
      if (rawSex.startsWith("M")) setSex("M");
      else if (rawSex.startsWith("F")) setSex("F");
      if (od.phone) setPhone(od.phone as string);
      if (od.club && clubs.data) {
        const match = fuzzyMatchClub(od.club as string, clubs.data);
        if (match) setClubId(match.id);
      }
    }

    // Notify kiosk
    const ch = kioskChannelRef.current;
    if (ch) {
      ch.send({
        type: "card-readout",
        card: {
          id: latest.id,
          cardNumber: latest.cardNumber,
          cardType: latest.cardType,
          action: "register",
          hasRaceData: false,
        },
      });
    }
  }, [isOpen, recentCards, clubs.data, isFormDirty]);

  // ── Default payment mode ────────────────────────────────
  useEffect(() => {
    if (paymentDefaultApplied.current || !regConfig.data) return;
    paymentDefaultApplied.current = true;
    const methods = regConfig.data.paymentMethods;
    if (methods.length > 0) setPaymentMode(methods[0] as typeof paymentMode);
  }, [regConfig.data]);

  // ── Manual card entry ───────────────────────────────────
  const startManualCard = useCallback(async (cardNumber: string) => {
    const num = parseInt(cardNumber, 10);
    if (!num || num <= 0) return;

    const existing = await utils.runner.findByCard.fetch({ cardNo: num });
    if (existing) {
      // Card already registered — show warning
      setCardNo(cardNumber);
      return;
    }

    setName("");
    setClassId(0);
    setClubId(0);
    setStartTime("");
    setBirthYear("");
    setSex("");
    setPhone("");
    setError("");
    setShowSuggestions(false);
    setDebouncedNameQuery("");
    setCardNo(cardNumber);

    const ch = kioskChannelRef.current;
    if (ch) {
      ch.send({
        type: "card-readout",
        card: {
          id: `manual-${num}-${Date.now()}`,
          cardNumber: num,
          cardType: "manual",
          action: "register",
          hasRaceData: false,
        },
      });
    }

    setTimeout(() => nameInputRef.current?.focus(), 50);
  }, [utils.runner.findByCard]);

  // ── Suggestions ─────────────────────────────────────────
  const triggerNameSearch = (value: string) => {
    setShowSuggestions(value.trim().length >= 2);
    setSelectedSuggestionIdx(-1);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
      debounceRef.current = setTimeout(() => setDebouncedNameQuery(trimmed), 300);
    } else {
      setDebouncedNameQuery("");
    }
  };

  const handleNameChange = (value: string) => {
    setName(value);
    triggerNameSearch(value);
  };

  const suggestions = useMemo(() => {
    const query = name.trim().toLowerCase();
    if (query.length < 2) return [];
    const results: { name: string; cardNo: number; birthYear: number; sex: string; clubName?: string; clubEventorId?: number; source: string }[] = [];
    const seen = new Set<string>();
    if (clubMembers.data) {
      for (const m of clubMembers.data) {
        const memberLower = m.name.toLowerCase();
        const parts = memberLower.split(/[, ]+/);
        const matches = memberLower.includes(query) || parts.some((p) => p.startsWith(query)) || query.split(/\s+/).every((q) => parts.some((p) => p.startsWith(q)));
        if (matches) {
          const key = `${m.name}|${m.cardNo}`;
          seen.add(key);
          results.push({ name: m.name, cardNo: m.cardNo, birthYear: m.birthYear, sex: m.sex, source: "eventor" });
        }
      }
    }
    if (globalSearch.data) {
      for (const r of globalSearch.data) {
        const key = `${r.name}|${r.cardNo}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ name: r.name, cardNo: r.cardNo, birthYear: r.birthYear, sex: r.sex, clubName: r.clubName, clubEventorId: r.clubEventorId, source: "runnerdb" });
      }
    }
    return results.slice(0, 12);
  }, [name, clubMembers.data, globalSearch.data]);

  const applySuggestion = useCallback((s: typeof suggestions[0]) => {
    const parts = s.name.split(", ");
    setName(parts.length === 2 ? `${parts[1]} ${parts[0]}` : s.name);
    if (s.cardNo > 0 && !cardNo) setCardNo(String(s.cardNo));
    if (s.birthYear > 0) setBirthYear(String(s.birthYear));
    if (s.sex) setSex(s.sex);
    if (s.source === "runnerdb" && s.clubEventorId && clubs.data) {
      const match = clubs.data.find((c) => c.extId === s.clubEventorId);
      if (match) setClubId(match.id);
    }
    setShowSuggestions(false);
    setSelectedSuggestionIdx(-1);
  }, [clubs.data, cardNo]);

  const handleNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (showSuggestions && suggestions.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSelectedSuggestionIdx((i) => Math.min(i + 1, suggestions.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSelectedSuggestionIdx((i) => Math.max(i - 1, -1)); }
      else if (e.key === "Enter" && selectedSuggestionIdx >= 0) { e.preventDefault(); applySuggestion(suggestions[selectedSuggestionIdx]); }
      else if (e.key === "Escape") { setShowSuggestions(false); }
    }
  };

  // ── Submit ──────────────────────────────────────────────
  const createMutation = trpc.runner.create.useMutation();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!name.trim()) { setError(t("nameRequired")); return; }
    if (!classId) { setError(t("classRequired")); return; }

    const classFee = classes.data?.classes.find((c) => c.id === classId)?.classFee ?? 0;
    const rentalFee = isRentalCard ? (cardFeeQuery.data?.cardFee ?? 0) : 0;
    let fee = 0;   // oRunner.Fee = entry fee only (NOT including rental)
    let paid = 0;  // oRunner.Paid = total collected (entry + rental)
    const payModeMap: Record<string, number> = { billed: 1, "on-site": 2, card: 3, swish: 4, cash: 5 };
    let payModeNum = 0;
    const totalFee = classFee + rentalFee;
    if (totalFee > 0 && paymentMode) {
      fee = classFee;  // Fee stores entry fee only; CardFee stores rental separately
      if (paymentMode !== "billed") paid = totalFee;  // Paid = total collected (entry + rental)
      payModeNum = payModeMap[paymentMode] ?? 0;
    }

    const trimmedName = name.trim();
    const cn = cardNo ? parseInt(cardNo, 10) : 0;
    const clsName = selectedClassName;
    const clbName = selectedClubName;
    const st = startTime;
    const pm = paymentMode;
    const competitionInfo = classes.data?.competition;
    const eventorId = classes.data?.organizer?.eventorId;
    const customMsg = regConfig.data?.registrationReceiptMessage || undefined;

    try {
      await createMutation.mutateAsync({
        name: trimmedName,
        classId,
        clubId: clubId || 0,
        cardNo: cn,
        startTime: st ? parseMeosTime(st) : 0,
        birthYear: birthYear ? parseInt(birthYear, 10) : 0,
        sex,
        phone,
        fee,
        paid,
        payMode: payModeNum,
        cardFee: rentalFee > 0 ? rentalFee : 0,
      });

      // Notify kiosk
      const ch = kioskChannelRef.current;
      if (ch && cn) {
        ch.send({
          type: "registration-complete",
          runner: { name: trimmedName, className: clsName, clubName: clbName, startTime: st, cardNo: cn },
        });
      }

      // Print receipt if configured
      if (printer.connected && regConfig.data?.printRegistrationReceipt) {
        const paymentLabels: Record<string, string> = { billed: t("invoice"), "on-site": t("payOnSite"), card: t("card"), swish: t("swish"), cash: t("cash") };
        const logoRaster = eventorId
          ? await fetchLogoRaster(getClubLogoUrl(eventorId), 250).catch(() => null)
          : null;
        await printer.printRegistration({
          competitionName: competitionInfo?.name ?? "",
          competitionDate: competitionInfo?.date ?? undefined,
          logoRaster,
          runner: { name: trimmedName, clubName: clbName, className: clsName, cardNo: cn },
          startTime: st || undefined,
          payment: totalFee > 0 && pm ? { method: paymentLabels[pm] ?? pm, amount: totalFee, cardFee: rentalFee > 0 ? rentalFee : undefined } : undefined,
          customMessage: customMsg,
          organizerName: classes.data?.organizer?.name,
          organizerDetails: regConfig.data?.organizerDetails || undefined,
          orgNumber: regConfig.data?.orgNumber || undefined,
          vatInfo: { exempt: regConfig.data?.vatExempt ?? true },
          friskvardNote: regConfig.data?.receiptFriskvardNote ?? false,
        }).catch(() => {});
      }

      // Add to recent
      addRecentRegistration({
        name: trimmedName,
        className: clsName,
        clubName: clbName,
        startTime: st,
        cardNo: cn,
        timestamp: new Date(),
      });

      // Invalidate queries
      utils.runner.list.invalidate();
      utils.runner.findByCard.invalidate({ cardNo: cn });
      utils.cardReadout.readout.invalidate({ cardNo: cn });
      utils.competition.dashboard.invalidate();

      if (stickyMode) {
        // Show success briefly, then clear form
        setSuccessMsg(t("registeredInClass", { name: trimmedName, className: clsName }));
        if (successTimerRef.current) clearTimeout(successTimerRef.current);
        successTimerRef.current = setTimeout(() => setSuccessMsg(""), 3000);
        clearForm();
        // Reset kiosk to idle between sticky registrations (after brief delay for completion display)
        setTimeout(() => {
          const ch2 = getKioskChannel();
          if (ch2) ch2.send({ type: "kiosk-reset" });
        }, 3000);
      } else {
        closeRegistration();
        // Don't send kiosk-reset here — the kiosk will display registration-complete
        // and auto-reset on its own. kiosk-reset is only sent on explicit close/cancel.
      }
    } catch (err: any) {
      setError(err.message ?? t("registrationFailed"));
    }
  };

  // ── ESC handling ────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Let suggestion dropdown handle its own ESC first (only if actually visible)
      if (showSuggestions && suggestions.length > 0) {
        setShowSuggestions(false);
        return;
      }
      if (stickyMode && isFormDirty) {
        // Clear form but keep dialog open
        clearForm();
        const ch = getKioskChannel();
        if (ch) ch.send({ type: "kiosk-reset" });
      } else {
        // Close dialog
        closeRegistration();
        const ch = getKioskChannel();
        if (ch) ch.send({ type: "kiosk-reset" });
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, stickyMode, isFormDirty, showSuggestions, suggestions.length, clearForm, closeRegistration, getKioskChannel]);

  // Reset form when dialog opens
  useEffect(() => {
    if (isOpen) {
      lastPendingCardRef.current = null;
      // Don't reset if pendingCard will populate
      if (!pendingCard) {
        clearForm();
      }
    }
  }, [isOpen]);

  if (!isOpen) return null;

  // ── Render ──────────────────────────────────────────────
  return (
    <div data-testid="registration-dialog" className="fixed inset-0 z-50 flex items-start justify-center pt-12 sm:pt-20">
      {/* Backdrop */}
      <div
        data-testid="registration-dialog-backdrop"
        className="absolute inset-0 bg-black/40"
        onClick={() => {
          if (!stickyMode || !isFormDirty) {
            closeRegistration();
            const ch = getKioskChannel();
            if (ch) ch.send({ type: "kiosk-reset" });
          }
        }}
      />

      {/* Dialog */}
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto mx-4" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 rounded-t-xl flex items-center justify-between z-10">
          <h2 className="text-lg font-semibold text-slate-900">{t("registerRunner")}</h2>
          <div className="flex items-center gap-3">
            {/* Sticky mode toggle */}
            <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none">
              <input
                type="checkbox"
                data-testid="reg-sticky-toggle"
                checked={stickyMode}
                onChange={toggleStickyMode}
                className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
              />
              {t("stickyMode")}
            </label>
            {/* Close button */}
            <button
              type="button"
              onClick={() => {
                closeRegistration();
                const ch = getKioskChannel();
                if (ch) ch.send({ type: "kiosk-reset" });
              }}
              className="p-1 text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
              aria-label="Close"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-4">
          {/* Success banner */}
          {successMsg && (
            <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm font-medium flex items-center gap-2">
              <svg className="w-5 h-5 text-green-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              {successMsg}
            </div>
          )}

          {/* Duplicate card warning */}
          {duplicateCheck.data && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm flex items-start gap-2">
              <svg className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <span>
                {t("duplicateCardWarning", {
                  cardNo: duplicateCheck.data.cardNo,
                  name: duplicateCheck.data.name,
                  className: duplicateCheck.data.className,
                })}
              </span>
            </div>
          )}

          {/* Waiting for card — when no card is set */}
          {!cardNo && !name && (
            <div className="mb-4 p-4 bg-slate-50 border border-slate-200 rounded-xl text-center">
              <div className="inline-block w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mb-3" />
              <p className="text-slate-600 font-medium">{t("waitingForCard")}</p>
              <p className="text-slate-400 text-sm mt-1">{t("insertCardOrEnterManually")}</p>
              <div className="mt-3 flex items-center justify-center gap-2">
                <input
                  ref={manualCardInputRef}
                  type="number"
                  placeholder={t("cardNumber")}
                  className="w-40 px-3 py-1.5 border border-slate-300 rounded-lg text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const val = (e.target as HTMLInputElement).value.trim();
                      if (val) startManualCard(val);
                    }
                  }}
                />
                <button
                  type="button"
                  className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors cursor-pointer"
                  onClick={() => {
                    const val = manualCardInputRef.current?.value.trim();
                    if (val) startManualCard(val);
                  }}
                >
                  {t("startButton")}
                </button>
              </div>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Club */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t("club")}</label>
              <SearchableSelect
                testId="reg-club"
                value={clubId}
                onChange={(v) => setClubId(Number(v))}
                placeholder={t("noClub")}
                searchPlaceholder={t("searchClubs")}
                options={[
                  { value: 0, label: t("noClub") },
                  ...(clubs.data?.map((c) => ({
                    value: c.id,
                    label: c.name,
                    icon: <ClubLogo clubId={c.id} size="sm" />,
                  })) ?? []),
                ]}
              />
            </div>

            {/* Name with autocomplete */}
            <div className="relative">
              <label className="block text-sm font-medium text-slate-700 mb-1">{t("name")} *</label>
              <input
                ref={nameInputRef}
                type="text"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                onKeyDown={handleNameKeyDown}
                onFocus={() => name.trim().length >= 2 && setShowSuggestions(true)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder={t("firstLast")}
                autoComplete="off"
              />
              {showSuggestions && suggestions.length > 0 && (
                <div ref={suggestionsRef} data-testid="name-suggestions" className="absolute z-[60] mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-52 overflow-y-auto">
                  {suggestions.map((s, i) => {
                    const parts = s.name.split(", ");
                    const displayName = parts.length === 2 ? `${parts[1]} ${parts[0]}` : s.name;
                    return (
                      <button
                        key={`${s.source}-${s.name}-${i}`}
                        type="button"
                        onClick={() => applySuggestion(s)}
                        className={`w-full px-3 py-2 text-left text-sm hover:bg-blue-50 cursor-pointer flex items-center gap-2 ${i === selectedSuggestionIdx ? "bg-blue-50" : ""}`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-slate-900 truncate">{displayName}</div>
                          <div className="text-xs text-slate-400 flex gap-2">
                            {s.clubName && <span>{s.clubName}</span>}
                            {s.birthYear > 0 && <span>{s.birthYear}</span>}
                            {s.sex && <span>{s.sex === "M" ? t("male") : t("female")}</span>}
                            {s.cardNo > 0 && <span>SI: {s.cardNo}</span>}
                          </div>
                        </div>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${s.source === "eventor" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"}`}>
                          {s.source === "eventor" ? t("clubSource") : t("runnerDbSource")}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Class */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t("class")} *</label>
              <SearchableSelect
                testId="reg-class"
                value={classId}
                onChange={(v) => setClassId(Number(v))}
                placeholder={t("selectClassPlaceholder")}
                searchPlaceholder={t("searchClasses")}
                alwaysShowSearch
                options={[
                  ...(classes.data?.classes.map((c) => {
                    const course = classes.data?.courses.find((co) => co.id === c.courseId);
                    const maps = course?.numberOfMaps;
                    const remaining = maps != null ? maps - (c.runnerCount ?? 0) : null;
                    return {
                      value: c.id,
                      label: c.name,
                      suffix: remaining != null ? (remaining <= 0 ? t("noMaps") : t("mapsRemaining", { count: remaining })) : undefined,
                      disabled: remaining != null && remaining <= 0,
                    };
                  }) ?? []),
                ]}
              />
            </div>

            {/* Card / Start time row */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("siCard")}</label>
                <input
                  type="number"
                  value={cardNo}
                  onChange={(e) => setCardNo(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder={t("siCardPlaceholder")}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("startTime")}</label>
                <input
                  type="text"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder={t("startTimePlaceholder")}
                />
              </div>
            </div>

            {/* Rental card toggle */}
            <div className="flex items-center gap-3 px-3 py-2 rounded-lg border border-slate-200 bg-slate-50">
              <label className="flex items-center gap-2 flex-1 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={isRentalCard}
                  onChange={(e) => setIsRentalCard(e.target.checked)}
                  data-testid="rental-card-checkbox"
                  className="rounded border-slate-300 text-orange-500 focus:ring-orange-400 cursor-pointer"
                />
                <span className="text-sm font-medium text-slate-700">{t("rentalCard")}</span>
              </label>
              {isRentalCard && (cardFeeQuery.data?.cardFee ?? 0) > 0 && (
                <span className="text-xs font-medium text-orange-600 bg-orange-50 border border-orange-200 rounded px-2 py-0.5">
                  +{cardFeeQuery.data!.cardFee} kr
                </span>
              )}
            </div>

            {/* Birth year / Sex row */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("birthYear")}</label>
                <input
                  type="number"
                  value={birthYear}
                  onChange={(e) => setBirthYear(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder={t("birthYearPlaceholder")}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("sex")}</label>
                <select
                  value={sex}
                  onChange={(e) => setSex(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
                >
                  <option value="">{t("notSpecified")}</option>
                  <option value="M">{t("male")}</option>
                  <option value="F">{t("female")}</option>
                </select>
              </div>
            </div>

            {/* Phone */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t("phone")}</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder={t("phonePlaceholder")}
              />
            </div>

            {/* Payment */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t("payment")}</label>
              <div className="flex gap-2 flex-wrap">
                {(regConfig.data?.paymentMethods ?? ["billed", "on-site"]).map((pm) => {
                  const labels: Record<string, string> = { billed: t("invoice"), "on-site": t("payOnSite"), card: t("card"), swish: t("swish"), cash: t("cash") };
                  const icons: Record<string, React.ReactNode> = {
                    billed: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>,
                    "on-site": <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" /></svg>,
                    card: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" /></svg>,
                    swish: <img src={swishIcon} alt="" className="w-4 h-4" />,
                    cash: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" /></svg>,
                  };
                  return (
                    <button
                      key={pm}
                      type="button"
                      onClick={() => setPaymentMode(paymentMode === pm ? "" : pm as typeof paymentMode)}
                      className={`flex-1 min-w-[80px] px-3 py-2 text-sm rounded-lg border transition-colors cursor-pointer flex items-center justify-center gap-1.5 ${paymentMode === pm
                        ? "bg-blue-50 border-blue-300 text-blue-700 font-medium"
                        : "border-slate-200 text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      {icons[pm]}
                      {labels[pm] ?? pm}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Error */}
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                {error}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => {
                  clearForm();
                  const ch = getKioskChannel();
                  if (ch) ch.send({ type: "kiosk-reset" });
                }}
                className="px-4 py-2.5 border border-slate-200 text-slate-700 text-sm font-medium rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
              >
                {t("clearEsc")}
              </button>
              <button
                type="submit"
                data-testid="reg-submit"
                disabled={createMutation.isPending}
                className="flex-1 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors cursor-pointer disabled:opacity-50"
              >
                {createMutation.isPending ? t("saving") : (
                  paymentMode && paymentMode !== "billed" && ((classes.data?.classes.find((c) => c.id === classId)?.classFee ?? 0) + (isRentalCard ? (cardFeeQuery.data?.cardFee ?? 0) : 0)) > 0
                    ? t("confirmPaymentRegister")
                    : t("registerRunner")
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
