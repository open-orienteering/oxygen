import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { parseMeosTime, formatMeosTime } from "@oxygen/shared";
import { SearchableSelect } from "../components/SearchableSelect";
import { ClubLogo } from "../components/ClubLogo";
import { useDeviceManager, type RecentCard } from "../context/DeviceManager";
import { usePrinter } from "../context/PrinterContext";
import { fetchLogoRaster } from "../lib/receipt-printer/index.js";
import type { KioskChannel, RegistrationFormState } from "../lib/kiosk-channel";
import { fuzzyMatchClub } from "../lib/fuzzy-club-match";

interface RecentRegistration {
  name: string;
  className: string;
  clubName: string;
  startTime: string;
  cardNo: number;
  timestamp: Date;
}

export function RegistrationPage() {
  const { t } = useTranslation("registration");
  const { recentCards, getKioskChannel } = useDeviceManager();
  const printer = usePrinter();
  const utils = trpc.useUtils();

  // Form state
  const [name, setName] = useState("");
  const [classId, setClassId] = useState<number>(0);
  const [clubId, setClubId] = useState<number>(0);
  const [cardNo, setCardNo] = useState("");
  const [startTime, setStartTime] = useState("");
  const [birthYear, setBirthYear] = useState("");
  const [sex, setSex] = useState("");
  const [phone, setPhone] = useState("");
  const [paymentMode, setPaymentMode] = useState<"billed" | "on-site" | "card" | "swish" | "">("");
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [recentRegistrations, setRecentRegistrations] = useState<RecentRegistration[]>([]);

  // Autocomplete state
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestionIdx, setSelectedSuggestionIdx] = useState(-1);
  const [debouncedNameQuery, setDebouncedNameQuery] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const manualCardInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<any>(undefined);

  // Track which card we've already consumed so we don't re-trigger
  const lastConsumedCardRef = useRef<string | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const kioskChannelRef = useRef<KioskChannel | null>(null);

  // Queries
  const classes = trpc.competition.dashboard.useQuery();
  const regConfig = trpc.competition.getRegistrationConfig.useQuery(undefined, {
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

  // Card number lookup for auto-fill
  const cardNoNum = cardNo ? parseInt(cardNo, 10) : 0;
  const cardLookup = trpc.eventor.lookupByCardNo.useQuery(
    { cardNo: cardNoNum },
    { enabled: cardNoNum > 0 && !name, staleTime: 60_000, retry: false },
  );

  // Global runner DB search
  const globalSearch = trpc.eventor.searchRunnerDb.useQuery(
    { query: debouncedNameQuery },
    { enabled: debouncedNameQuery.length >= 2, staleTime: 30_000, retry: false },
  );

  // Kiosk channel
  useEffect(() => {
    const ch = getKioskChannel();
    kioskChannelRef.current = ch;
    return () => { kioskChannelRef.current = null; };
  }, [getKioskChannel]);

  // Manual card entry — mimics what happens when a real card is read
  const startManualCard = useCallback((cardNumber: string) => {
    const num = parseInt(cardNumber, 10);
    if (!num || num <= 0) return;
    // Reset form fields
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

    // Notify kiosk so it enters registration-waiting mode
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
  }, []);

  // Default payment mode
  const paymentDefaultApplied = useRef(false);
  useEffect(() => {
    if (paymentDefaultApplied.current || !regConfig.data) return;
    paymentDefaultApplied.current = true;
    const methods = regConfig.data.paymentMethods;
    if (methods.includes("billed")) setPaymentMode("billed");
    else if (methods.length > 0) setPaymentMode(methods[0] as typeof paymentMode);
  }, [regConfig.data]);

  // Auto-fill from card lookup
  useEffect(() => {
    if (!cardLookup.data || name) return;
    const r = cardLookup.data;
    if (r.name) {
      const parts = r.name.split(", ");
      const displayName = parts.length === 2 ? `${parts[1]} ${parts[0]}` : r.name;
      setName(displayName);
      triggerNameSearch(displayName);
    }
    if (!birthYear && r.birthYear > 0) setBirthYear(String(r.birthYear));
    if (!sex && r.sex) setSex(r.sex);
    if (!clubId && r.clubEventorId && clubs.data) {
      const match = clubs.data.find((c) => c.extId === r.clubEventorId);
      if (match) setClubId(match.id);
    }
  }, [cardLookup.data, clubs.data]);

  // Auto-populate from card reads
  useEffect(() => {
    if (recentCards.length === 0) return;
    const latest = recentCards[0];
    if (latest.action !== "register") return;
    if (lastConsumedCardRef.current === latest.id) return;
    lastConsumedCardRef.current = latest.id;

    // Clear form and populate from card
    clearForm();
    setCardNo(String(latest.cardNumber));
    if (latest.ownerData) {
      const od = latest.ownerData;
      const n = [od.firstName, od.lastName].filter(Boolean).join(" ");
      if (n) {
        setName(n);
        triggerNameSearch(n);
      }
      if (od.dateOfBirth) setBirthYear(od.dateOfBirth.substring(0, 4));
      const rawSex = od.sex?.trim().toUpperCase() ?? "";
      if (rawSex.startsWith("M")) setSex("M");
      else if (rawSex.startsWith("F")) setSex("F");
      if (od.phone) setPhone(od.phone);
      // Fuzzy-match club from SI card owner data
      if (od.club && clubs.data) {
        const match = fuzzyMatchClub(od.club, clubs.data);
        if (match) setClubId(match.id);
      }
    }

    // Focus name field
    setTimeout(() => nameInputRef.current?.focus(), 100);
  }, [recentCards]);

  // Broadcast form state to kiosk
  const selectedClubName = selectedClub?.name ?? "";
  const selectedClassName = classes.data?.classes.find((c) => c.id === classId)?.name ?? "";

  useEffect(() => {
    const ch = kioskChannelRef.current;
    if (!ch || !cardNo) return;

    const classFee = classes.data?.classes.find((c) => c.id === classId)?.classFee ?? 0;
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
      fee: classFee > 0 ? classFee : undefined,
      swishNumber: regConfig.data?.swishNumber || undefined,
      clubEventorId: selectedClub?.extId || undefined,
      competitionName: classes.data?.competition?.name || undefined,
    };
    const ready = !!name.trim() && classId > 0;
    ch.send({ type: "registration-state", form, ready });
  }, [name, selectedClubName, selectedClassName, cardNo, startTime, sex, birthYear, phone, paymentMode, classId, classes.data, regConfig.data]);

  // Suggestions
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

  const clearForm = () => {
    setName("");
    setClassId(0);
    setClubId(0);
    setCardNo("");
    setStartTime("");
    setBirthYear("");
    setSex("");
    setPhone("");
    setError("");
    setPaymentMode(regConfig.data?.paymentMethods.includes("billed") ? "billed" : regConfig.data?.paymentMethods[0] as typeof paymentMode || "");
    setShowSuggestions(false);
    setDebouncedNameQuery("");
    paymentDefaultApplied.current = false;
  };

  const createMutation = trpc.runner.create.useMutation();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!name.trim()) { setError(t("nameRequired")); return; }
    if (!classId) { setError(t("classRequired")); return; }

    const classFee = classes.data?.classes.find((c) => c.id === classId)?.classFee ?? 0;
    let fee = 0;
    let paid = 0;
    if (classFee > 0 && paymentMode) {
      fee = classFee;
      if (paymentMode !== "billed") paid = classFee;
    }

    // Capture form values before clearForm resets them
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
        const paymentLabels: Record<string, string> = { billed: t("invoice"), "on-site": t("payOnSite"), card: t("card"), swish: t("swish") };
        const logoRaster = eventorId
          ? await fetchLogoRaster(`/api/club-logo/${eventorId}?variant=large`, 250).catch(() => null)
          : null;
        await printer.printRegistration({
          competitionName: competitionInfo?.name ?? "",
          competitionDate: competitionInfo?.date ?? undefined,
          logoRaster,
          runner: { name: trimmedName, clubName: clbName, className: clsName, cardNo: cn },
          startTime: st || undefined,
          payment: classFee > 0 && pm ? { method: paymentLabels[pm] ?? pm, amount: classFee } : undefined,
          customMessage: customMsg,
        }).catch(() => {});
      }

      // Add to recent list
      setRecentRegistrations((prev) => [
        { name: trimmedName, className: clsName, clubName: clbName, startTime: st, cardNo: cn, timestamp: new Date() },
        ...prev.slice(0, 19),
      ]);

      // Show success
      setSuccessMsg(t("registeredInClass", { name: trimmedName, className: clsName }));
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      successTimerRef.current = setTimeout(() => setSuccessMsg(""), 4000);

      // Invalidate queries
      utils.runner.list.invalidate();
      utils.competition.dashboard.invalidate();

      // Clear form for next
      clearForm();
      nameInputRef.current?.focus();
    } catch (err: any) {
      setError(err.message ?? t("registrationFailed"));
    }
  };

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

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions || suggestions.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedSuggestionIdx((prev) => prev < suggestions.length - 1 ? prev + 1 : 0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelectedSuggestionIdx((prev) => prev > 0 ? prev - 1 : suggestions.length - 1); }
    else if (e.key === "Enter" && selectedSuggestionIdx >= 0) { e.preventDefault(); applySuggestion(suggestions[selectedSuggestionIdx]); }
    else if (e.key === "Escape") { setShowSuggestions(false); }
  };

  // Close suggestions on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node) && nameInputRef.current && !nameInputRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Handle Escape to clear form and reset kiosk
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Always clear form + reset kiosk on ESC.
      // (Suggestion dropdown is closed by the input's own onKeyDown handler.)
      setShowSuggestions(false);
      clearForm();
      nameInputRef.current?.focus();
      const ch = getKioskChannel();
      if (ch) ch.send({ type: "kiosk-reset" });
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [getKioskChannel]);

  return (
    <div className="flex gap-6">
      {/* Main form */}
      <div className="flex-1 max-w-2xl">
        {/* Success banner */}
        {successMsg && (
          <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm font-medium flex items-center gap-2">
            <svg className="w-5 h-5 text-green-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {successMsg}
          </div>
        )}

        {/* Waiting indicator when no card — with manual entry option */}
        {!cardNo && !name && (
          <div className="mb-6 p-6 bg-slate-50 border border-slate-200 rounded-xl text-center">
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
              autoFocus
            />
            {showSuggestions && suggestions.length > 0 && (
              <div ref={suggestionsRef} className="absolute z-50 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-52 overflow-y-auto">
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
                const labels: Record<string, string> = { billed: t("invoice"), "on-site": t("payOnSite"), card: t("card"), swish: t("swish") };
                return (
                  <button
                    key={pm}
                    type="button"
                    onClick={() => setPaymentMode(paymentMode === pm ? "" : pm as typeof paymentMode)}
                    className={`flex-1 min-w-[80px] px-3 py-2 text-sm rounded-lg border transition-colors cursor-pointer ${paymentMode === pm
                      ? "bg-blue-50 border-blue-300 text-blue-700 font-medium"
                      : "border-slate-200 text-slate-600 hover:bg-slate-50"
                    }`}
                  >
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
              onClick={() => { clearForm(); nameInputRef.current?.focus(); }}
              className="px-4 py-2.5 border border-slate-200 text-slate-700 text-sm font-medium rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
            >
              {t("clearEsc")}
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="flex-1 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors cursor-pointer disabled:opacity-50"
            >
              {createMutation.isPending ? t("saving") : t("registerRunner")}
            </button>
          </div>
        </form>
      </div>

      {/* Recent registrations sidebar */}
      <div className="w-72 flex-shrink-0">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">{t("recentRegistrations")}</h3>
        {recentRegistrations.length === 0 ? (
          <p className="text-sm text-slate-400">{t("noRegistrationsYet")}</p>
        ) : (
          <div className="space-y-2">
            {recentRegistrations.map((r, i) => (
              <div key={i} className="p-3 bg-white border border-slate-200 rounded-lg text-sm">
                <div className="font-medium text-slate-900">{r.name}</div>
                <div className="text-xs text-slate-500 flex gap-2 mt-0.5">
                  <span>{r.className}</span>
                  {r.clubName && <span>{r.clubName}</span>}
                </div>
                <div className="text-xs text-slate-400 mt-0.5 flex justify-between">
                  <span>SI: {r.cardNo}</span>
                  <span>{r.startTime || t("freeStart")}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
