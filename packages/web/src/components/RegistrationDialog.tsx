import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { parseClockTime } from "@oxygen/shared";
import { SearchableSelect } from "./SearchableSelect";
import { ClubLogo } from "./ClubLogo";
import { useDeviceManager } from "../context/DeviceManager";
import { useRegistrationDialog } from "../context/RegistrationDialogContext";
import { usePrinter } from "../context/PrinterContext";
import { fetchLogoRaster } from "../lib/receipt-printer/index.js";
import { getClubLogoUrl } from "../lib/club-logo";
import type { KioskChannel, RegistrationFormState } from "../lib/kiosk-channel";
import { fuzzyMatchClub } from "../lib/fuzzy-club-match";
import { emitRunnerRegistered } from "../lib/offline/events";
import {
  NO_CLUB,
  findClubOption,
  mergeClubOptions,
  optionForClub,
  resolveClubKey,
  rosterClubOptions,
  searchCachedClubs,
  type ClubKey,
  type ClubOption,
} from "../lib/club-options";
import {
  defaultPaymentMode,
  registrationErrorMessage,
  type PaymentMode,
} from "../lib/registration-form";
import {
  filterRegistrationClasses,
  competitionYearFromDate,
} from "../lib/registration-class-filter";
import swishIcon from "../assets/swish-icon.svg";

/**
 * Check if card owner data contains a real name (not SPORTident factory defaults).
 * Factory defaults: firstName = card number (purely numeric), lastName = "SPORTident Sweden" etc.
 */
function isRealOwnerName(firstName?: string, lastName?: string): boolean {
  if (!firstName && !lastName) return false;
  if (firstName && /^\d+$/.test(firstName.trim())) return false;
  if (lastName && /sportident/i.test(lastName)) return false;
  return true;
}

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
  // Club choice by key, never by the roster's numeric id: free-text clubs
  // share id 0 with "No club" (WEB-06). See lib/club-options.ts.
  const [clubKey, setClubKey] = useState<ClubKey>(NO_CLUB);
  // Clubs picked from outside the event's roster (a suggestion, a card
  // lookup, a directory search) kept as options so they show and submit (WEB-11).
  const [adHocClubs, setAdHocClubs] = useState<ClubOption[]>([]);
  const [clubSearch, setClubSearch] = useState("");
  const [debouncedClubSearch, setDebouncedClubSearch] = useState("");
  const [cardNo, setCardNo] = useState("");
  const [startTime, setStartTime] = useState("");
  const [birthYear, setBirthYear] = useState("");
  const [sex, setSex] = useState("");
  const [phone, setPhone] = useState("");
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("");
  const [isRentalCard, setIsRentalCard] = useState(false);
  const [printReceipt, setPrintReceipt] = useState(false);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  // One registration at a time: the online mutation, the offline queue and
  // the printing all run inside it (WEB-20).
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const printChainRef = useRef<Promise<void>>(Promise.resolve());

  // Autocomplete state
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestionIdx, setSelectedSuggestionIdx] = useState(-1);
  const [debouncedNameQuery, setDebouncedNameQuery] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const manualCardInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const lastConsumedCardRef = useRef<string | null>(null);
  const lastPendingCardRef = useRef<number | null>(null);
  // Owner data of the card it was read from: only ever applied to that card
  // number, so an earlier card's owner cannot name the next one (WEB-05).
  const pendingOwnerDataRef = useRef<{ cardNo: number; od: Record<string, string> } | null>(null);
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
  const clubs = trpc.club.list.useQuery();
  const syncStatus = trpc.eventor.syncStatus.useQuery();
  const env = syncStatus.data?.env || "prod";
  const keyStatus = trpc.eventor.keyStatus.useQuery({ env });

  // Cached runner DB dump for offline autocomplete + card lookup
  const runnerDbDump = trpc.eventor.runnerDbDump.useQuery(undefined, {
    staleTime: 10 * 60_000,
    gcTime: Infinity,
    enabled: false, // Populated by useStationSync; don't re-fetch here
  });

  // ── Club options ────────────────────────────────────────
  const rosterClubs = useMemo(() => rosterClubOptions(clubs.data), [clubs.data]);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedClubSearch(clubSearch.trim()), 250);
    return () => clearTimeout(id);
  }, [clubSearch]);
  // A club not yet in the event: searched in the club directory when the
  // roster has no match (online), or in the cached runner DB's clubs.
  // Directory hits are listed under the roster for any search of two or
  // more characters, so a club whose name is part of a roster club's is
  // still reachable.
  const wantDirectory = debouncedClubSearch.length >= 2;
  const directorySearch = trpc.club.searchDirectory.useQuery(
    { query: debouncedClubSearch },
    { enabled: wantDirectory && navigator.onLine, staleTime: 5 * 60_000, retry: false },
  );
  const directoryClubs = useMemo((): ClubOption[] => {
    if (!wantDirectory) return [];
    if (directorySearch.data) {
      return directorySearch.data.map((d) => ({
        key: `e:${d.eventorId}`,
        name: d.name,
        eventorId: d.eventorId,
        source: "directory" as const,
      }));
    }
    return searchCachedClubs(runnerDbDump.data?.clubs as Record<number, string> | undefined, debouncedClubSearch);
  }, [wantDirectory, directorySearch.data, runnerDbDump.data, debouncedClubSearch]);
  const clubOptions = useMemo(
    () => mergeClubOptions(rosterClubs, adHocClubs, directoryClubs),
    [rosterClubs, adHocClubs, directoryClubs],
  );
  const selectedClub = findClubOption(clubOptions, clubKey);

  /** Select a club that came with a suggestion or a lookup; false when it has nothing to show. */
  const pickClub = useCallback((club: { eventorId?: number | null; name?: string | null }): boolean => {
    const o = optionForClub(rosterClubs, club);
    if (!o) return false;
    if (o.source !== "roster") setAdHocClubs((prev) => mergeClubOptions(prev, [{ ...o, source: "adhoc" }]));
    setClubKey(o.key);
    return true;
  }, [rosterClubs]);

  /** The club an SI card's owner data names: the roster first, then the cached directory. */
  const matchOwnerClub = useCallback((ownerClub: string): boolean => {
    const roster = clubs.data ?? [];
    const hit = fuzzyMatchClub(ownerClub, roster);
    if (hit) {
      const c = roster.find((r) => r === hit) ?? (hit as (typeof roster)[number]);
      return pickClub({ eventorId: c.extId || c.id || undefined, name: c.name });
    }
    const cached = runnerDbDump.data?.clubs as Record<number, string> | undefined;
    if (!cached) return false;
    const candidates = Object.entries(cached).map(([id, n]) => ({ id: Number(id), name: n, shortName: "", runnerCount: 0 }));
    const dirHit = fuzzyMatchClub(ownerClub, candidates);
    return dirHit ? pickClub({ eventorId: dirHit.id, name: dirHit.name }) : false;
  }, [clubs.data, runnerDbDump.data, pickClub]);

  // Eventor member lookup
  const eventorOrgId = selectedClub?.eventorId || undefined;
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

  // The card already belongs to a runner in this event: registering it again
  // would be refused (WEB-22), so the submit is disabled while this holds.
  const cardKnown = !!duplicateCheck.data && duplicateCheck.data.cardNo === cardNoNum;

  // Card number lookup for auto-fill — use local cache if available, else server
  const cardLookupServer = trpc.eventor.lookupByCardNo.useQuery(
    { cardNo: cardNoNum },
    { enabled: cardNoNum > 0 && !name && !runnerDbDump.data && duplicateCheck.isFetched && duplicateCheck.data === null, staleTime: 60_000, retry: false },
  );
  const cardLookupLocal = useMemo(() => {
    if (!runnerDbDump.data || cardNoNum <= 0) return null;
    const { runners, clubs: clubMap } = runnerDbDump.data;
    const match = (runners as [string, number, number, number, string][]).find((r) => r[1] === cardNoNum);
    if (!match) return null;
    return { name: match[0], cardNo: match[1], clubEventorId: match[2], birthYear: match[3], sex: match[4], clubName: clubMap[match[2]] ?? "" };
  }, [runnerDbDump.data, cardNoNum]);
  const cardLookup = { data: cardLookupLocal ?? cardLookupServer.data ?? null };

  // Global runner DB search — fall back to server when local cache empty
  const globalSearch = trpc.eventor.searchRunnerDb.useQuery(
    { query: debouncedNameQuery },
    {
      // Only use server search if local cache is empty
      enabled: debouncedNameQuery.length >= 2 && !runnerDbDump.data,
      staleTime: 30_000,
      retry: false,
    },
  );

  // ── Derived ─────────────────────────────────────────────
  const selectedClubName = selectedClub?.name ?? "";

  // Class list filtered by what the user has entered so far. Always restricted
  // to allowQuickEntry classes (on-site registration), then narrowed further
  // by sex / age when those fields are known.
  const eligibleClasses = useMemo(() => {
    const all = classes.data?.classes ?? [];
    const competitionYear = competitionYearFromDate(classes.data?.competition?.date);
    const birthYearNum = birthYear ? parseInt(birthYear, 10) : 0;
    return filterRegistrationClasses(all, {
      sex,
      birthYear: birthYearNum > 0 ? birthYearNum : undefined,
      competitionYear,
    });
  }, [classes.data, sex, birthYear]);

  // If the picked class is no longer eligible (e.g. user just picked a sex
  // that excludes it), treat the selection as cleared. Doing this in render
  // — rather than via an effect that calls setClassId — keeps the picker,
  // the displayed class name, and form submission consistent without
  // triggering an extra render pass.
  const effectiveClassId = useMemo(() => {
    if (!classId) return 0;
    return eligibleClasses.some((c) => c.id === classId) ? classId : 0;
  }, [classId, eligibleClasses]);
  const selectedClassName =
    classes.data?.classes.find((c) => c.id === effectiveClassId)?.name ?? "";

  // ── Clear form ──────────────────────────────────────────
  const clearForm = useCallback(() => {
    setName("");
    setClassId(0);
    setClubKey(NO_CLUB);
    setAdHocClubs([]);
    setCardNo("");
    setStartTime("");
    setBirthYear("");
    setSex("");
    setPhone("");
    setError("");
    setSuccessMsg("");
    // Per-runner choices never carry to the next runner (WEB-19).
    setIsRentalCard(false);
    setPrintReceipt(false);
    setPaymentMode(defaultPaymentMode(regConfig.data));
    setShowSuggestions(false);
    setDebouncedNameQuery("");
    pendingOwnerDataRef.current = null;
    duplicatePrefilled.current = 0;
  }, [regConfig.data]);

  const isFormDirty = !!(name || cardNo || classId || clubKey || birthYear || sex || phone);

  // ── Kiosk channel ───────────────────────────────────────
  useEffect(() => {
    if (!isOpen) {
      kioskChannelRef.current = null;
      return;
    }
    const ch = getKioskChannel();
    kioskChannelRef.current = ch;
    // The runner can tap a button on the kiosk to ask for a receipt. The
    // admin form is the source of truth for the toggle, so we just mirror
    // the requested value here.
    const unsub = ch?.subscribe((msg) => {
      if (msg.type === "kiosk-request-registration-receipt") {
        setPrintReceipt(msg.printReceipt);
      }
    });
    return () => {
      unsub?.();
      kioskChannelRef.current = null;
    };
  }, [isOpen, getKioskChannel]);

  // Broadcast form state to kiosk
  const buildFormMessage = useCallback(() => {
    const classFee = classes.data?.classes.find((c) => c.id === effectiveClassId)?.classFee ?? 0;
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
      clubEventorId: selectedClub?.eventorId || undefined,
      competitionName: classes.data?.competition?.name || undefined,
      isRentalCard: isRentalCard || undefined,
      cardFee: rentalFee > 0 ? rentalFee : undefined,
      // Only surface the toggle to the kiosk when receipt printing is
      // enabled at the event level; otherwise leave it `undefined` so the
      // kiosk hides the receipt panel completely.
      printReceipt: regConfig.data?.printRegistrationReceipt ? printReceipt : undefined,
    };
    const ready = !!name.trim() && effectiveClassId > 0;
    return { form, ready };
  }, [name, selectedClubName, selectedClassName, cardNo, startTime, sex, birthYear, phone, paymentMode, isRentalCard, printReceipt, effectiveClassId, classes.data, regConfig.data, cardFeeQuery.data, selectedClub?.eventorId]);

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

  const clearFormRef = useRef(clearForm);
  clearFormRef.current = clearForm;
  const matchOwnerClubRef = useRef(matchOwnerClub);
  matchOwnerClubRef.current = matchOwnerClub;

  // ── Pending card from context ───────────────────────────
  useEffect(() => {
    if (!isOpen || !pendingCard) return;
    if (lastPendingCardRef.current === pendingCard.cardNo) return;
    lastPendingCardRef.current = pendingCard.cardNo;

    // A fresh form for this card: the rental tick, receipt tick and payment
    // of the previous runner do not carry over (WEB-19).
    clearFormRef.current();

    setCardNo(String(pendingCard.cardNo));

    // Store owner data for deferred name fill (DB data takes priority — see below)
    pendingOwnerDataRef.current = pendingCard.ownerData
      ? { cardNo: pendingCard.cardNo, od: pendingCard.ownerData }
      : null;
    if (pendingCard.ownerData) {
      const od = pendingCard.ownerData;
      // Fill non-name fields immediately (these don't conflict with DB runner data)
      if (od.dateOfBirth) setBirthYear(od.dateOfBirth.substring(0, 4));
      const rawSex = od.sex?.trim().toUpperCase() ?? "";
      if (rawSex.startsWith("M")) setSex("M");
      else if (rawSex.startsWith("F")) setSex("F");
      if (od.phone) setPhone(od.phone);
      if (od.club) matchOwnerClubRef.current(od.club);
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
    // Only a new card (or a reopen) re-runs this: a refetch of the club
    // list or the registration config must not wipe a half-filled form, so
    // the helpers are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, pendingCard]);

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
    if (!clubKey && r.clubEventorId) pickClub({ eventorId: r.clubEventorId, name: r.clubName });
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
    if (d.clubId || d.clubName) pickClub({ eventorId: d.clubId || undefined, name: d.clubName });
    setShowSuggestions(false);
  }, [duplicateCheck.data]);

  // ── Deferred owner data name fill (only if no DB runner match) ──
  useEffect(() => {
    if (!isOpen) return;
    if (duplicateCheck.isLoading || !duplicateCheck.isFetched) return;
    if (duplicateCheck.data) return; // Runner found in DB — DB data wins
    if (name) return; // Name already set (e.g., from Eventor lookup)
    const pending = pendingOwnerDataRef.current;
    // Only the owner data read from this very card (WEB-05).
    if (!pending || pending.cardNo !== cardNoNum) return;
    const od = pending.od;
    const n = [od.firstName, od.lastName].filter(Boolean).join(" ");
    if (n && isRealOwnerName(od.firstName, od.lastName)) {
      setName(n);
      // Focus class selector since name is now filled
      setTimeout(() => {
        const classBtn = document.querySelector<HTMLElement>('[data-testid="reg-class"] button');
        classBtn?.focus();
      }, 150);
    }
  }, [isOpen, duplicateCheck.isFetched, duplicateCheck.isLoading, duplicateCheck.data, name, cardNoNum]);

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
    // A card without owner data must not inherit the previous card's (WEB-05).
    pendingOwnerDataRef.current = null;
    if (latest.ownerData) {
      const od = latest.ownerData;
      // Store for deferred name fill (DB data takes priority)
      pendingOwnerDataRef.current = { cardNo: latest.cardNumber, od: od as Record<string, string> };
      // Fill non-name fields immediately
      if (od.dateOfBirth) setBirthYear((od.dateOfBirth as string).substring(0, 4));
      const rawSex = (od.sex as string)?.trim().toUpperCase() ?? "";
      if (rawSex.startsWith("M")) setSex("M");
      else if (rawSex.startsWith("F")) setSex("F");
      if (od.phone) setPhone(od.phone as string);
      if (od.club) matchOwnerClub(od.club as string);
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
  }, [isOpen, recentCards, isFormDirty, matchOwnerClub]);

  // ── Default payment mode ────────────────────────────────
  useEffect(() => {
    if (paymentDefaultApplied.current || !regConfig.data) return;
    paymentDefaultApplied.current = true;
    setPaymentMode(defaultPaymentMode(regConfig.data));
  }, [regConfig.data]);

  // ── Manual card entry ───────────────────────────────────
  const startManualCard = useCallback(async (cardNumber: string) => {
    const num = parseInt(cardNumber, 10);
    if (!num || num <= 0) return;

    // The check is a convenience: offline, or when the server does not
    // answer, the form opens anyway and the submit decides (WEB-22).
    let existing: unknown = null;
    if (navigator.onLine) {
      try {
        existing = await utils.runner.findByCard.fetch({ cardNo: num });
      } catch (err) {
        console.error("[registration] card check failed", err);
      }
    }
    if (existing) {
      // Card already registered — show warning
      setCardNo(cardNumber);
      return;
    }

    clearForm();
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
  }, [utils.runner.findByCard, clearForm]);

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
    // Search cached runner DB dump (local, instant) or fall back to server results
    if (runnerDbDump.data) {
      const queryWords = query.split(/\s+/).filter((w) => w.length > 0);
      const isNumeric = /^\d+$/.test(query);
      const { runners, clubs } = runnerDbDump.data;
      let matchCount = 0;
      for (const r of runners) {
        if (matchCount >= 15) break;
        const [rName, rCardNo, rClubId, rBirthYear, rSex] = r as [string, number, number, number, string];
        const key = `${rName}|${rCardNo}`;
        if (seen.has(key)) continue;

        let matches: boolean;
        if (isNumeric) {
          matches = String(rCardNo).startsWith(query);
        } else {
          const nameLower = rName.toLowerCase();
          const nameParts = nameLower.split(/[, ]+/);
          matches = nameLower.includes(query)
            || nameParts.some((p) => p.startsWith(query))
            || queryWords.every((q) => nameParts.some((p) => p.startsWith(q)));
        }
        if (matches) {
          seen.add(key);
          results.push({
            name: rName,
            cardNo: rCardNo,
            birthYear: rBirthYear,
            sex: rSex,
            clubName: clubs[rClubId] ?? "",
            clubEventorId: rClubId || undefined,
            source: "runnerdb",
          });
          matchCount++;
        }
      }
    } else if (globalSearch.data) {
      for (const r of globalSearch.data) {
        const key = `${r.name}|${r.cardNo}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ name: r.name, cardNo: r.cardNo, birthYear: r.birthYear, sex: r.sex, clubName: r.clubName, clubEventorId: r.clubEventorId, source: "runnerdb" });
      }
    }
    return results.slice(0, 12);
  }, [name, clubMembers.data, runnerDbDump.data, globalSearch.data]);

  const applySuggestion = useCallback((s: typeof suggestions[0]) => {
    const parts = s.name.split(", ");
    setName(parts.length === 2 ? `${parts[1]} ${parts[0]}` : s.name);
    if (s.cardNo > 0 && !cardNo) setCardNo(String(s.cardNo));
    if (s.birthYear > 0) setBirthYear(String(s.birthYear));
    if (s.sex) setSex(s.sex);
    if (s.source === "runnerdb" && s.clubEventorId) pickClub({ eventorId: s.clubEventorId, name: s.clubName });
    setShowSuggestions(false);
    setSelectedSuggestionIdx(-1);
  }, [pickClub, cardNo]);

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
    // A second Enter or click while the first is still saving is ignored:
    // it would create the runner twice, or queue it twice offline (WEB-20).
    if (submittingRef.current) return;
    setError("");
    if (cardKnown) { setError(t("errorCardTaken")); return; }

    if (!name.trim()) { setError(t("nameRequired")); return; }
    if (!effectiveClassId) { setError(t("classRequired")); return; }
    // Strict clock time (RES-13): "10:30" is 10:30:00, a half-typed value is refused.
    const startDs = startTime.trim() ? parseClockTime(startTime) : 0;
    if (startDs === null) { setError(t("invalidClockTime")); return; }

    const classFee = classes.data?.classes.find((c) => c.id === effectiveClassId)?.classFee ?? 0;
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
    const club = resolveClubKey(clubOptions, clubKey);
    const birthYearNum = birthYear ? parseInt(birthYear, 10) : 0;
    const wantsReceipt = printer.connected && !!regConfig.data?.printRegistrationReceipt && printReceipt;

    submittingRef.current = true;
    setSubmitting(true);
    try {
      let registeredOnline = false;
      if (navigator.onLine) {
        try {
          await createMutation.mutateAsync({
            name: trimmedName,
            classId: effectiveClassId,
            clubName: club.clubName,
            eventorClubId: club.eventorClubId ?? undefined,
            cardNo: cn,
            startTime: startDs,
            birthYear: birthYearNum,
            sex,
            phone,
            fee,
            paid,
            payMode: payModeNum,
            cardFee: rentalFee > 0 ? rentalFee : 0,
          });
          registeredOnline = true;
        } catch (err) {
          // Server error while online — don't silently queue; say what to do.
          console.error("[registration] runner.create failed", err);
          throw new Error(registrationErrorMessage(err, t), { cause: err });
        }
      } else {
        // Offline — queue the registration event
        const nameId = window.location.pathname.match(/^\/([^/]+)/)?.[1] ?? "";
        // The whole form, as the online path sends it (SYNC-12).
        await emitRunnerRegistered(nameId, {
          tempId: crypto.randomUUID(),
          name: trimmedName,
          classId: effectiveClassId,
          clubName: club.clubName,
          ...(club.eventorClubId ? { eventorClubId: club.eventorClubId } : {}),
          cardNo: cn > 0 ? cn : null,
          ...(startDs > 0 ? { startTime: startDs } : {}),
          birthYear: birthYearNum,
          sex,
          phone,
          fee,
          paid,
          payMode: payModeNum,
          cardFee: rentalFee > 0 ? rentalFee : 0,
        });
      }

      // Notify kiosk
      const ch = kioskChannelRef.current;
      if (ch && cn) {
        ch.send({
          type: "registration-complete",
          runner: { name: trimmedName, className: clsName, clubName: clbName, startTime: st, cardNo: cn },
        });
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

      // Invalidate queries (only when online — offline would clear cached data we need)
      if (registeredOnline) {
        utils.runner.list.invalidate();
        utils.runner.findByCard.invalidate({ cardNo: cn });
        utils.cardReadout.readout.invalidate({ cardNo: cn });
        utils.competition.dashboard.invalidate();
      }

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

      // Print receipt only when the event has receipt printing enabled,
      // the operator (or runner via the kiosk) opted in for this individual
      // registration, and a printer is connected. After the form is cleared
      // or closed and not awaited: the runner is registered whatever the
      // printer does, and a slow logo or a stuck printer must not hold the
      // desk (WEB-20). The logo load and the USB transfer are time-bounded.
      if (wantsReceipt) {
        const paymentLabels: Record<string, string> = { billed: t("invoice"), "on-site": t("payOnSite"), card: t("card"), swish: t("swish"), cash: t("cash") };
        const cfg = regConfig.data;
        const organizerName = classes.data?.organizer?.name;
        // Prints go out one after another: a second registration does not
        // start a USB transfer while the first is still in flight.
        printChainRef.current = printChainRef.current.then(async () => {
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
            organizerName,
            organizerDetails: cfg?.organizerDetails || undefined,
            orgNumber: cfg?.orgNumber || undefined,
            vatInfo: { exempt: cfg?.vatExempt ?? true },
            friskvardNote: cfg?.receiptFriskvardNote ?? false,
          });
        }).catch((err) => console.error("[registration] receipt print failed", err));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("registrationFailed"));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
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
      if (stickyMode) {
        // Sticky mode: ESC clears a dirty form but never closes the dialog.
        if (isFormDirty) {
          clearForm();
          const ch = getKioskChannel();
          if (ch) ch.send({ type: "kiosk-reset" });
        }
        return;
      }
      // Non-sticky: ESC closes the dialog.
      closeRegistration();
      const ch = getKioskChannel();
      if (ch) ch.send({ type: "kiosk-reset" });
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
                value={clubKey}
                onChange={(v) => {
                  const key = String(v);
                  // A directory pick stays an option after the search closes.
                  // The pick stays an option after the search closes, and
                  // after a roster refetch drops its club (its last runner
                  // moved): it is submitted with its own name and id.
                  const o = findClubOption(clubOptions, key);
                  if (o) setAdHocClubs((prev) => mergeClubOptions(prev, [{ ...o, source: "adhoc" }]));
                  setClubKey(key);
                }}
                onSearchChange={setClubSearch}
                // Always searchable: a club not yet in the event is found
                // in the club directory (WEB-11).
                alwaysShowSearch
                placeholder={t("noClub")}
                searchPlaceholder={t("searchClubs")}
                options={[
                  { value: NO_CLUB, label: t("noClub") },
                  ...clubOptions.map((c) => ({
                    value: c.key,
                    label: c.name,
                    icon: c.eventorId ? <ClubLogo clubId={c.eventorId} size="sm" /> : undefined,
                  })),
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
                value={effectiveClassId}
                onChange={(v) => setClassId(Number(v))}
                placeholder={t("selectClassPlaceholder")}
                searchPlaceholder={t("searchClasses")}
                alwaysShowSearch
                options={eligibleClasses.map((c) => {
                  const course = classes.data?.courses.find((co) => co.id === c.courseId);
                  const maps = course?.numberOfMaps;
                  const remaining = maps != null ? maps - (c.runnerCount ?? 0) : null;
                  return {
                    value: c.id,
                    label: c.name,
                    suffix: remaining != null ? (remaining <= 0 ? t("noMaps") : t("mapsRemaining", { count: remaining })) : undefined,
                    disabled: remaining != null && remaining <= 0,
                  };
                })}
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

            {/* Rental card + Print receipt toggles */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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
              {(() => {
                const printingEnabled = !!regConfig.data?.printRegistrationReceipt;
                const printerOffline = printingEnabled && !printer.connected;
                return (
                  <div
                    className={`flex items-center gap-3 px-3 py-2 rounded-lg border border-slate-200 ${
                      printingEnabled ? "bg-slate-50" : "bg-slate-100/60"
                    }`}
                  >
                    <label
                      className={`flex items-center gap-2 flex-1 select-none ${
                        printingEnabled ? "cursor-pointer" : "cursor-not-allowed"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={printingEnabled && printReceipt}
                        disabled={!printingEnabled}
                        onChange={(e) => setPrintReceipt(e.target.checked)}
                        data-testid="print-receipt-checkbox"
                        className={`rounded border-slate-300 text-blue-500 focus:ring-blue-400 ${
                          printingEnabled ? "cursor-pointer" : "cursor-not-allowed opacity-50"
                        }`}
                      />
                      <span
                        className={`text-sm font-medium ${
                          printingEnabled ? "text-slate-700" : "text-slate-400"
                        }`}
                      >
                        {t("printReceipt")}
                      </span>
                    </label>
                    {!printingEnabled && (
                      <span
                        className="text-[10px] font-medium text-slate-500 bg-slate-200/70 border border-slate-200 rounded px-2 py-0.5"
                        title={t("printingDisabledHint")}
                      >
                        {t("printingDisabled")}
                      </span>
                    )}
                    {printerOffline && (
                      <span
                        className="text-[10px] font-medium text-slate-500 bg-slate-100 border border-slate-200 rounded px-2 py-0.5"
                        title={t("printerNotConnected")}
                      >
                        {t("printerOffline")}
                      </span>
                    )}
                  </div>
                );
              })()}
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
                disabled={submitting || cardKnown}
                className="flex-1 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors cursor-pointer disabled:opacity-50"
              >
                {submitting ? t("saving") : (
                  paymentMode && paymentMode !== "billed" && ((classes.data?.classes.find((c) => c.id === effectiveClassId)?.classFee ?? 0) + (isRentalCard ? (cardFeeQuery.data?.cardFee ?? 0) : 0)) > 0
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
