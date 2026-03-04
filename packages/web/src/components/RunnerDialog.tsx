import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { trpc } from "../lib/trpc";
import { parseMeosTime, formatMeosTime } from "@oxygen/shared";
import { SearchableSelect } from "./SearchableSelect";
import { ClubLogo } from "./ClubLogo";
import { useDeviceManager } from "../context/DeviceManager";
import type { KioskChannel, RegistrationFormState } from "../lib/kiosk-channel";

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
  const [paymentMode, setPaymentMode] = useState<"billed" | "on-site" | "">("");
  const [error, setError] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestionIdx, setSelectedSuggestionIdx] = useState(-1);
  const [kioskConfirmed, setKioskConfirmed] = useState(false);
  const [debouncedNameQuery, setDebouncedNameQuery] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<any>(undefined);
  const { getKioskChannel, setPendingConfirmCardNo } = useDeviceManager();

  const classes = trpc.competition.dashboard.useQuery();
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
          },
        });
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
      const ownerClub = initialOwnerData.club.toLowerCase();
      const match = clubs.data.find(
        (c) => c.name.toLowerCase() === ownerClub ||
          c.name.toLowerCase().includes(ownerClub) ||
          ownerClub.includes(c.name.toLowerCase()),
      );
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

  // ── Kiosk integration: broadcast form state + listen for confirm ──
  const kioskChannelRef = useRef<KioskChannel | null>(null);

  useEffect(() => {
    if (mode !== "create" || !initialCardNo) return;
    const ch = getKioskChannel();
    kioskChannelRef.current = ch;
    if (!ch) return;

    const unsub = ch.subscribe((msg) => {
      if (msg.type === "registration-confirm" && msg.confirmed) {
        setKioskConfirmed(true);
      }
    });

    return () => {
      unsub();
      kioskChannelRef.current = null;
      setPendingConfirmCardNo(null);
    };
  }, [mode, initialCardNo, getKioskChannel, setPendingConfirmCardNo]);

  // Broadcast form state to kiosk whenever fields change
  const selectedClubName = selectedClub?.name ?? "";
  const selectedClassName = classes.data?.classes.find((c) => c.id === classId)?.name ?? "";

  useEffect(() => {
    if (mode !== "create" || !initialCardNo) return;
    const ch = kioskChannelRef.current;
    if (!ch) return;

    const form: RegistrationFormState = {
      name,
      clubName: selectedClubName,
      className: selectedClassName,
      courseName: "", // not directly available but not critical
      cardNo: cardNo ? parseInt(cardNo, 10) : initialCardNo ?? 0,
      startTime,
      sex,
      birthYear,
      phone,
      paymentMode,
    };

    // Only send ready=true when we have at least name + class
    const ready = !!name.trim() && classId > 0;
    ch.send({ type: "registration-state", form, ready });

    // Set pending confirmation card so DeviceManager can detect re-insert.
    // Pass a direct callback so we get notified in the same page (BroadcastChannel
    // only delivers to other browsing contexts).
    if (ready && initialCardNo) {
      setPendingConfirmCardNo(initialCardNo, () => setKioskConfirmed(true));
    }
  }, [mode, initialCardNo, name, selectedClubName, selectedClassName, cardNo, startTime, sex, birthYear, phone, paymentMode, classId, setPendingConfirmCardNo]);

  const handleNameChange = (value: string) => {
    setName(value);
    setShowSuggestions(value.trim().length >= 2);
    setSelectedSuggestionIdx(-1);

    // Debounce the global runner DB search (300ms)
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
      debounceRef.current = setTimeout(() => {
        setDebouncedNameQuery(trimmed);
      }, 300);
    } else {
      setDebouncedNameQuery("");
    }
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
      setError("Name is required");
      return;
    }
    if (!classId) {
      setError("Class is required");
      return;
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
            {mode === "create" ? "Add Runner" : "Edit Runner"}
          </h2>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Club — placed first so Eventor members are fetched before name entry */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Club
            </label>
            <SearchableSelect
              testId="dialog-club"
              value={clubId}
              onChange={(v) => setClubId(Number(v))}
              placeholder="No club"
              searchPlaceholder="Search clubs..."
              options={[
                { value: 0, label: "No club" },
                ...(clubs.data?.map((c) => ({
                  value: c.id,
                  label: c.name,
                  icon: <ClubLogo clubId={c.id} size="sm" />,
                })) ?? []),
              ]}
            />
            {canFetchMembers && clubMembers.isLoading && (
              <div className="text-xs text-slate-400 mt-1">Loading club members...</div>
            )}
            {canFetchMembers && clubMembers.data && (
              <div className="text-xs text-slate-400 mt-1">
                {clubMembers.data.length} members loaded — type name for suggestions
              </div>
            )}
          </div>

          {/* Name with autocomplete */}
          <div className="relative">
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Name *
            </label>
            <input
              ref={nameInputRef}
              type="text"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              onKeyDown={handleNameKeyDown}
              onFocus={() => name.trim().length >= 2 && setShowSuggestions(true)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="First Last"
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
                          {s.sex && <span>{s.sex === "M" ? "Male" : "Female"}</span>}
                          {s.cardNo > 0 && <span>SI: {s.cardNo}</span>}
                        </div>
                      </div>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${s.source === "eventor"
                        ? "bg-blue-100 text-blue-700"
                        : "bg-purple-100 text-purple-700"
                        }`}>
                        {s.source === "eventor" ? "Club" : "Runner DB"}
                      </span>
                    </button>
                  );
                })}
                {globalSearch.isFetching && (
                  <div className="px-3 py-2 text-xs text-slate-400 flex items-center gap-2">
                    <div className="w-3 h-3 border-2 border-slate-300 border-t-transparent rounded-full animate-spin" />
                    Searching runner database...
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Class */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Class *
            </label>
            <SearchableSelect
              testId="dialog-class"
              value={classId}
              onChange={(v) => setClassId(Number(v))}
              placeholder="Select class..."
              searchPlaceholder="Search classes..."
              options={[
                { value: 0, label: "Select class..." },
                ...(classes.data?.classes.map((c) => ({
                  value: c.id,
                  label: c.name,
                })) ?? []),
              ]}
            />
          </div>

          {/* Card / Start time row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                SI Card
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
                Start Time
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
                Birth Year
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
                Sex
              </label>
              <select
                value={sex}
                onChange={(e) => setSex(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
              >
                <option value="">Not specified</option>
                <option value="M">Male</option>
                <option value="F">Female</option>
              </select>
            </div>
          </div>

          {/* Phone */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Phone
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
                Payment
              </label>
              <div className="flex gap-2">
                {(["", "billed", "on-site"] as const).map((pm) => (
                  <button
                    key={pm || "none"}
                    type="button"
                    onClick={() => setPaymentMode(pm)}
                    className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-colors cursor-pointer ${paymentMode === pm
                      ? "bg-blue-50 border-blue-300 text-blue-700 font-medium"
                      : "border-slate-200 text-slate-600 hover:bg-slate-50"
                      }`}
                  >
                    {pm === "" ? "Not set" : pm === "billed" ? "Invoice" : "Pay on site"}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Kiosk confirmation indicator */}
          {mode === "create" && initialCardNo && kioskChannelRef.current && (
            <div className={`p-3 rounded-lg text-sm flex items-center gap-2 ${kioskConfirmed
              ? "bg-emerald-50 border border-emerald-200 text-emerald-700"
              : "bg-blue-50 border border-blue-200 text-blue-700"
              }`}>
              {kioskConfirmed ? (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  User confirmed on kiosk
                </>
              ) : (
                <>
                  <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                  Waiting for user confirmation on kiosk...
                </>
              )}
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
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="flex-1 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors cursor-pointer disabled:opacity-50"
            >
              {isPending
                ? "Saving..."
                : mode === "create"
                  ? "Add Runner"
                  : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
