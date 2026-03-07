import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { parseMeosTime, formatMeosTime } from "@oxygen/shared";
import { SearchableSelect } from "./SearchableSelect";
import { ClubLogo } from "./ClubLogo";
import { useDeviceManager } from "../context/DeviceManager";
import { usePrinter } from "../context/PrinterContext";
import { fetchLogoRaster } from "../lib/receipt-printer/index.js";
import type { KioskChannel, RegistrationFormState } from "../lib/kiosk-channel";
import { fuzzyMatchClub } from "../lib/fuzzy-club-match";

interface Props {
  mode: "create" | "edit";
  runnerId?: number;
  /** Pre-fill card number when creating from SI reader */
  initialCardNo?: number;
  /** Pre-fill owner data read from the SI card */
  initialOwnerData?: {
    firstName?: string;
    lastName?: string;
    club?: string;
    sex?: string;
    dateOfBirth?: string;
    phone?: string;
  };
  onClose: () => void;
  onSuccess: () => void;
}

/** A suggestion that can auto-fill the form */
interface Suggestion {
  name: string;
  cardNo: number;
  birthYear: number;
  sex: string;
  clubName?: string;
  clubEventorId?: number;
  source: "eventor" | "runnerdb";
}

export function RunnerDialog({ mode, runnerId, initialCardNo, initialOwnerData, onClose, onSuccess }: Props) {
  const { t } = useTranslation("runners");
  // Pre-fill from SI card owner data when available
  const ownerName = initialOwnerData
    ? [initialOwnerData.firstName, initialOwnerData.lastName].filter(Boolean).join(" ")
    : "";
  const ownerBirthYear = initialOwnerData?.dateOfBirth
    ? initialOwnerData.dateOfBirth.substring(0, 4) // "19900101" → "1990"
    : "";

  // Normalize sex from SI card (could be "M", "m", "Male", "F", "f", "Female", etc.)
  const normalizedSex = (() => {
    const raw = initialOwnerData?.sex?.trim().toUpperCase() ?? "";
    if (raw === "M" || raw.startsWith("M")) return "M";
    if (raw === "F" || raw.startsWith("F")) return "F";
    return "";
  })();

  const [name, setName] = useState(ownerName);
  const [classId, setClassId] = useState<number>(0);
  const [clubId, setClubId] = useState<number>(0);
  const [cardNo, setCardNo] = useState(initialCardNo ? String(initialCardNo) : "");
  const [startTime, setStartTime] = useState("");
  const [birthYear, setBirthYear] = useState(ownerBirthYear);
  const [sex, setSex] = useState(normalizedSex);
  const [phone, setPhone] = useState(initialOwnerData?.phone ?? "");
  const [paymentMode, setPaymentMode] = useState<"billed" | "on-site" | "card" | "swish" | "">("");
  const [error, setError] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestionIdx, setSelectedSuggestionIdx] = useState(-1);
  const [debouncedNameQuery, setDebouncedNameQuery] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<any>(undefined);
  const { getKioskChannel } = useDeviceManager();
  const printer = usePrinter();

  const classes = trpc.competition.dashboard.useQuery();
  const regConfig = trpc.competition.getRegistrationConfig.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });
  // Use showAll to include clubs without runners (important for new runner registration)
  const clubs = trpc.club.list.useQuery({ showAll: true });
  const syncStatus = trpc.eventor.syncStatus.useQuery();
  const env = syncStatus.data?.env || "prod";
  const keyStatus = trpc.eventor.keyStatus.useQuery({ env });
  const runner =
    mode === "edit" && runnerId
      ? trpc.runner.getById.useQuery({ id: runnerId })
      : null;

  // Find the Eventor org ID for the selected club
  const selectedClub = clubs.data?.find((c) => c.id === clubId);
  const eventorOrgId = selectedClub?.extId || undefined;

  // The Eventor API only allows fetching members for the API key owner's club
  const ownOrgId = keyStatus.data && "organisationId" in keyStatus.data
    ? keyStatus.data.organisationId
    : undefined;
  const canFetchMembers = !!eventorOrgId && !!ownOrgId && eventorOrgId === ownOrgId;

  const clubMembers = trpc.eventor.clubMembers.useQuery(
    { organisationId: eventorOrgId!, env },
    {
      enabled: canFetchMembers,
      staleTime: 10 * 60_000, // Cache for 10 min
      retry: false,
    },
  );

  // Card number lookup in global runner DB (auto-fill on mount)
  const cardLookup = trpc.eventor.lookupByCardNo.useQuery(
    { cardNo: initialCardNo! },
    {
      enabled: mode === "create" && !!initialCardNo && initialCardNo > 0,
      staleTime: 60_000,
      retry: false,
    },
  );

  // Auto-fill from runner DB lookup (runs once when data arrives)
  const cardLookupAppliedRef = useRef(false);
  useEffect(() => {
    if (cardLookupAppliedRef.current || !cardLookup.data) return;
    cardLookupAppliedRef.current = true;
    const r = cardLookup.data;
    // Only fill fields that are still empty (don't overwrite SI card owner data)
    if (!name && r.name) {
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

  // Trigger runner DB search when name is pre-filled from SI card owner data
  const ownerNameSearched = useRef(false);
  useEffect(() => {
    if (ownerNameSearched.current || !ownerName) return;
    ownerNameSearched.current = true;
    triggerNameSearch(ownerName);
  }, [ownerName]);

  // Default payment mode to "billed" when config loaded
  const paymentDefaultApplied = useRef(false);
  useEffect(() => {
    if (paymentDefaultApplied.current || !regConfig.data || mode !== "create") return;
    paymentDefaultApplied.current = true;
    const methods = regConfig.data.paymentMethods;
    if (methods.includes("billed")) setPaymentMode("billed");
    else if (methods.length > 0) setPaymentMode(methods[0] as typeof paymentMode);
  }, [regConfig.data, mode]);

  // Global runner DB search (debounced)
  const globalSearch = trpc.eventor.searchRunnerDb.useQuery(
    { query: debouncedNameQuery },
    {
      enabled: debouncedNameQuery.length >= 2,
      staleTime: 30_000,
      retry: false,
    },
  );

  // Compute suggestions from both club members (local) and global runner DB
  const suggestions = useMemo((): Suggestion[] => {
    const query = name.trim().toLowerCase();
    if (query.length < 2) return [];

    const results: Suggestion[] = [];
    const seen = new Set<string>(); // Deduplicate by name+cardNo

    // 1. Search Eventor club members (higher priority)
    if (clubMembers.data) {
      for (const m of clubMembers.data) {
        const memberLower = m.name.toLowerCase();
        const parts = memberLower.split(/[, ]+/);
        const matches =
          memberLower.includes(query) ||
          parts.some((p) => p.startsWith(query)) ||
          query.split(/\s+/).every((q) => parts.some((p) => p.startsWith(q)));

        if (matches) {
          const key = `${m.name}|${m.cardNo}`;
          seen.add(key);
          results.push({
            name: m.name,
            cardNo: m.cardNo,
            birthYear: m.birthYear,
            sex: m.sex,
            source: "eventor",
          });
        }
      }
    }

    // 2. Add global runner DB results (lower priority, deduplicated)
    if (globalSearch.data) {
      for (const r of globalSearch.data) {
        const key = `${r.name}|${r.cardNo}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          name: r.name,
          cardNo: r.cardNo,
          birthYear: r.birthYear,
          sex: r.sex,
          clubName: r.clubName,
          clubEventorId: r.clubEventorId,
          source: "runnerdb",
        });
      }
    }

    return results.slice(0, 12);
  }, [name, clubMembers.data, globalSearch.data]);

  const createMutation = trpc.runner.create.useMutation({
    onSuccess: () => {
      // Notify kiosk that registration is complete
      const ch = kioskChannelRef.current;
      if (ch && initialCardNo) {
        ch.send({
          type: "registration-complete",
          runner: {
            name: name.trim(),
            className: selectedClassName,
            clubName: selectedClubName,
            startTime,
            cardNo: cardNo ? parseInt(cardNo, 10) : initialCardNo,
            clubEventorId: selectedClub?.extId || undefined,
          },
        });
      }

      // Print registration receipt if printer connected and config enabled
      if (printer.connected && regConfig.data?.printRegistrationReceipt) {
        const classFee = classes.data?.classes.find((c) => c.id === classId)?.classFee ?? 0;
        const paymentLabels: Record<string, string> = {
          billed: "Invoice",
          "on-site": "Pay on site",
          card: "Card",
          swish: "Swish",
        };
        const competitionInfo = classes.data?.competition;
        const eventorId = classes.data?.organizer?.eventorId;
        (async () => {
          const logoRaster = eventorId
            ? await fetchLogoRaster(`/api/club-logo/${eventorId}?variant=large`, 250).catch(() => null)
            : null;
          await printer.printRegistration({
            competitionName: competitionInfo?.name ?? "",
            competitionDate: competitionInfo?.date ?? undefined,
            logoRaster,
            runner: {
              name: name.trim(),
              clubName: selectedClubName,
              className: selectedClassName,
              cardNo: cardNo ? parseInt(cardNo, 10) : initialCardNo ?? 0,
            },
            startTime: startTime || undefined,
            payment: classFee > 0 && paymentMode ? {
              method: paymentLabels[paymentMode] ?? paymentMode,
              amount: classFee,
            } : undefined,
            customMessage: regConfig.data?.registrationReceiptMessage || undefined,
          });
        })().catch(() => {}); // Don't block on print failure
      }

      onSuccess();
    },
    onError: (err) => setError(err.message),
  });
  const updateMutation = trpc.runner.update.useMutation({
    onSuccess,
    onError: (err) => setError(err.message),
  });

  // Populate form when editing
  useEffect(() => {
    if (runner?.data) {
      const r = runner.data;
      setName(r.name);
      setClassId(r.classId);
      setClubId(r.clubId);
      setCardNo(r.cardNo > 0 ? String(r.cardNo) : "");
      setStartTime(r.startTime > 0 ? formatMeosTime(r.startTime) : "");
      setBirthYear(r.birthYear > 0 ? String(r.birthYear) : "");
      setSex(r.sex);
      setPhone(r.phone);
    }
  }, [runner?.data]);

  // Auto-match club from SI card owner data
  useEffect(() => {
    if (initialOwnerData?.club && clubs.data && clubId === 0) {
      const match = fuzzyMatchClub(initialOwnerData.club, clubs.data);
      if (match) {
        setClubId(match.id);
      }
    }
  }, [initialOwnerData?.club, clubs.data, clubId]);

  // Close suggestions on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(e.target as Node) &&
        nameInputRef.current &&
        !nameInputRef.current.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const applySuggestion = useCallback((s: Suggestion) => {
    // Convert "Family, Given" to "Given Family" for display
    const parts = s.name.split(", ");
    const displayName = parts.length === 2 ? `${parts[1]} ${parts[0]}` : s.name;
    setName(displayName);
    if (s.cardNo > 0) setCardNo(String(s.cardNo));
    if (s.birthYear > 0) setBirthYear(String(s.birthYear));
    if (s.sex) setSex(s.sex);
    // Auto-select the club from global runner DB
    if (s.source === "runnerdb" && s.clubEventorId && clubs.data) {
      const match = clubs.data.find((c) => c.extId === s.clubEventorId);
      if (match) setClubId(match.id);
    }
    setShowSuggestions(false);
    setSelectedSuggestionIdx(-1);
  }, [clubs.data]);

  // ── Kiosk integration: broadcast form state ──
  const kioskChannelRef = useRef<KioskChannel | null>(null);

  useEffect(() => {
    if (mode !== "create" || !initialCardNo) return;
    const ch = getKioskChannel();
    kioskChannelRef.current = ch;

    return () => {
      kioskChannelRef.current = null;
    };
  }, [mode, initialCardNo, getKioskChannel]);

  // Broadcast form state to kiosk whenever fields change
  const selectedClubName = selectedClub?.name ?? "";
  const selectedClassName = classes.data?.classes.find((c) => c.id === classId)?.name ?? "";

  useEffect(() => {
    if (mode !== "create" || !initialCardNo) return;
    const ch = kioskChannelRef.current;
    if (!ch) return;

    const classFeeForBroadcast = classes.data?.classes.find((c) => c.id === classId)?.classFee ?? 0;
    const form: RegistrationFormState = {
      name,
      clubName: selectedClubName,
      className: selectedClassName,
      courseName: "",
      cardNo: cardNo ? parseInt(cardNo, 10) : initialCardNo ?? 0,
      startTime,
      sex,
      birthYear,
      phone,
      paymentMode,
      fee: classFeeForBroadcast > 0 ? classFeeForBroadcast : undefined,
      swishNumber: regConfig.data?.swishNumber || undefined,
      clubEventorId: selectedClub?.extId || undefined,
      competitionName: classes.data?.competition?.name || undefined,
    };

    // Only send ready=true when we have at least name + class
    const ready = !!name.trim() && classId > 0;
    ch.send({ type: "registration-state", form, ready });
  }, [mode, initialCardNo, name, selectedClubName, selectedClassName, cardNo, startTime, sex, birthYear, phone, paymentMode, classId, classes.data, regConfig.data]);

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

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedSuggestionIdx((prev) =>
        prev < suggestions.length - 1 ? prev + 1 : 0,
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedSuggestionIdx((prev) =>
        prev > 0 ? prev - 1 : suggestions.length - 1,
      );
    } else if (e.key === "Enter" && selectedSuggestionIdx >= 0) {
      e.preventDefault();
      applySuggestion(suggestions[selectedSuggestionIdx]);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!name.trim()) {
      setError(t("nameRequired"));
      return;
    }
    if (!classId) {
      setError(t("classRequired"));
      return;
    }

    // Compute fee from class fee schedule when payment mode is set
    const classFee = classes.data?.classes.find((c) => c.id === classId)?.classFee ?? 0;
    let fee = 0;
    let paid = 0;
    if (classFee > 0 && paymentMode) {
      fee = classFee;
      if (paymentMode === "billed") {
        paid = 0; // Paid=0 implies invoice (MeOS convention)
      } else {
        // on-site, card, swish — all count as paid immediately
        paid = classFee;
      }
    }

    const data = {
      name: name.trim(),
      classId,
      clubId: clubId || 0,
      cardNo: cardNo ? parseInt(cardNo, 10) : 0,
      startTime: startTime ? parseMeosTime(startTime) : 0,
      birthYear: birthYear ? parseInt(birthYear, 10) : 0,
      sex,
      phone,
      fee,
      paid,
    };

    if (mode === "create") {
      createMutation.mutate(data);
    } else if (runnerId) {
      updateMutation.mutate({ id: runnerId, data });
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-900">
            {mode === "create" ? t("addRunner") : t("editRunner")}
          </h2>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Club — placed first so Eventor members are fetched before name entry */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              {t("club")}
            </label>
            <SearchableSelect
              testId="dialog-club"
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
            {canFetchMembers && clubMembers.isLoading && (
              <div className="text-xs text-slate-400 mt-1">{t("loadingClubMembers")}</div>
            )}
            {canFetchMembers && clubMembers.data && (
              <div className="text-xs text-slate-400 mt-1">
                {t("membersLoaded", { count: clubMembers.data.length })}
              </div>
            )}
          </div>

          {/* Name with autocomplete */}
          <div className="relative">
            <label className="block text-sm font-medium text-slate-700 mb-1">
              {t("name")} *
            </label>
            <input
              ref={nameInputRef}
              type="text"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              onKeyDown={handleNameKeyDown}
              onFocus={() => name.trim().length >= 2 && setShowSuggestions(true)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder={t("namePlaceholder")}
              autoComplete="off"
              autoFocus
            />

            {/* Suggestions dropdown */}
            {showSuggestions && suggestions.length > 0 && (
              <div
                ref={suggestionsRef}
                className="absolute z-50 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-52 overflow-y-auto"
              >
                {suggestions.map((s, i) => {
                  const parts = s.name.split(", ");
                  const displayName = parts.length === 2 ? `${parts[1]} ${parts[0]}` : s.name;
                  return (
                    <button
                      key={`${s.source}-${s.name}-${i}`}
                      type="button"
                      onClick={() => applySuggestion(s)}
                      className={`w-full px-3 py-2 text-left text-sm hover:bg-blue-50 cursor-pointer flex items-center gap-2 ${i === selectedSuggestionIdx ? "bg-blue-50" : ""
                        }`}
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
                      <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${s.source === "eventor"
                        ? "bg-blue-100 text-blue-700"
                        : "bg-purple-100 text-purple-700"
                        }`}>
                        {s.source === "eventor" ? t("suggestionClub") : t("suggestionRunnerDb")}
                      </span>
                    </button>
                  );
                })}
                {globalSearch.isFetching && (
                  <div className="px-3 py-2 text-xs text-slate-400 flex items-center gap-2">
                    <div className="w-3 h-3 border-2 border-slate-300 border-t-transparent rounded-full animate-spin" />
                    {t("searchingRunnerDb")}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Class */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              {t("class")} *
            </label>
            <SearchableSelect
              testId="dialog-class"
              value={classId}
              onChange={(v) => setClassId(Number(v))}
              placeholder={t("selectClass")}
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
              <label className="block text-sm font-medium text-slate-700 mb-1">
                {t("siCard")}
              </label>
              <input
                type="number"
                value={cardNo}
                onChange={(e) => setCardNo(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="e.g. 500123"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                {t("startTime")}
              </label>
              <input
                type="text"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="HH:MM:SS"
              />
            </div>
          </div>

          {/* Birth year / Sex row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                {t("birthYear")}
              </label>
              <input
                type="number"
                value={birthYear}
                onChange={(e) => setBirthYear(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="e.g. 1990"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                {t("sex")}
              </label>
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
            <label className="block text-sm font-medium text-slate-700 mb-1">
              {t("phone")}
            </label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="+46..."
            />
          </div>

          {/* Payment mode (create mode only) */}
          {mode === "create" && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                {t("payment")}
              </label>
              <div className="flex gap-2 flex-wrap">
                {(regConfig.data?.paymentMethods ?? ["billed", "on-site"]).map((pm) => {
                  const labels: Record<string, string> = {
                    billed: t("payInvoice"),
                    "on-site": t("payOnSite"),
                    card: t("payCard"),
                    swish: "Swish",
                  };
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
          )}


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
              onClick={onClose}
              className="flex-1 px-4 py-2.5 border border-slate-200 text-slate-700 text-sm font-medium rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
            >
              {t("cancel")}
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="flex-1 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors cursor-pointer disabled:opacity-50"
            >
              {isPending
                ? t("saving")
                : mode === "create"
                  ? t("addRunner")
                  : t("saveChanges")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
