import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";

// Dynamic-key indirection: typed t() requires literal keys at call site.
// Classification labels are resolved from a runtime id, so we route through
// this loose-typed helper to escape the strict key-literal constraint.
type LooseT = (k: string) => string;
function tDynamic(t: unknown, key: string): string {
  return (t as LooseT)(key);
}

interface ComparisonSelection {
  id: number;
  name: string;
  date: string;
  organiserName: string;
}

interface Props {
  /** YYYY-MM-DD race date used to centre the default search window. */
  eventDate: string;
  /** Eventor event IDs the user has already added — pre-checked + disabled. */
  alreadySelected: ReadonlySet<number>;
  onClose: () => void;
  onConfirm: (selected: ComparisonSelection[]) => void;
}

const CLASSIFICATION_KEYS: Record<number, string> = {
  1: "classificationChampionship",
  2: "classificationNational",
  3: "classificationDistrict",
  4: "classificationLocal",
  5: "classificationClub",
  6: "classificationInternational",
};

export function ComparisonPickerDialog({
  eventDate,
  alreadySelected,
  onClose,
  onConfirm,
}: Props) {
  const { t } = useTranslation("trends");
  const [daysAround, setDaysAround] = useState(14);
  const [classification, setClassification] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Map<number, ComparisonSelection>>(
    new Map(),
  );

  // ─── Add-by-ID flow ───────────────────────────────────────
  const [idInput, setIdInput] = useState("");
  const [lookupError, setLookupError] = useState<string | null>(null);
  const lookupMutation = trpc.registrationTrends.lookupEventorEvent.useMutation();

  const handleLookup = async () => {
    setLookupError(null);
    if (!idInput.trim()) return;
    try {
      const result = await lookupMutation.mutateAsync({
        eventIdOrUrl: idInput.trim(),
      });
      if (alreadySelected.has(result.id)) {
        setLookupError(t("lookupFailed", { message: "already added" }));
        return;
      }
      setPicked((prev) => {
        const next = new Map(prev);
        next.set(result.id, {
          id: result.id,
          name: result.name,
          date: result.date,
          organiserName: result.organiserName ?? "",
        });
        return next;
      });
      setIdInput("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLookupError(t("lookupFailed", { message: msg }));
    }
  };

  // ─── Browse flow ──────────────────────────────────────────
  const eventsQuery = trpc.registrationTrends.findComparableEvents.useQuery(
    {
      daysAround,
      ...(classification ? { classificationIds: [classification] } : {}),
    },
    {
      staleTime: 60_000,
      retry: false,
    },
  );

  const filteredEvents = useMemo(() => {
    const all = eventsQuery.data?.events ?? [];
    const term = search.trim().toLowerCase();
    if (!term) return all;
    return all.filter(
      (e) =>
        e.name.toLowerCase().includes(term) ||
        e.organiserName.toLowerCase().includes(term),
    );
  }, [eventsQuery.data, search]);

  const togglePick = (e: {
    id: number;
    name: string;
    date: string;
    organiserName: string;
  }) => {
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(e.id)) {
        next.delete(e.id);
      } else {
        next.set(e.id, {
          id: e.id,
          name: e.name,
          date: e.date,
          organiserName: e.organiserName,
        });
      }
      return next;
    });
  };

  const browseErrorMessage =
    eventsQuery.error?.data?.code === "PRECONDITION_FAILED"
      ? t("noKeyConfigured")
      : eventsQuery.error?.message;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">
            {t("addComparison")}
          </h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 cursor-pointer"
            aria-label={t("cancel")}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Add by event ID / URL — primary path */}
          <div className="px-6 py-4 border-b border-slate-100">
            <h3 className="text-sm font-semibold text-slate-700 mb-1">
              {t("addByIdHeading")}
            </h3>
            <p className="text-xs text-slate-500 mb-2">{t("addByIdHelp")}</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={idInput}
                onChange={(e) => {
                  setIdInput(e.target.value);
                  setLookupError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleLookup();
                  }
                }}
                placeholder={t("addByIdPlaceholder")}
                className="flex-1 text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400"
              />
              <button
                onClick={() => void handleLookup()}
                disabled={!idInput.trim() || lookupMutation.isPending}
                className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
              >
                {lookupMutation.isPending ? t("lookingUp") : t("lookup")}
              </button>
            </div>
            {lookupError && (
              <p className="text-xs text-red-600 mt-2">{lookupError}</p>
            )}
            {picked.size > 0 && (
              <div className="mt-3 space-y-1">
                {[...picked.values()].map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between bg-blue-50 border border-blue-200 rounded-lg px-3 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-blue-900 truncate">
                        {p.name}
                      </div>
                      <div className="text-xs text-blue-700 truncate">
                        {p.date} {p.organiserName ? "· " + p.organiserName : ""}
                      </div>
                    </div>
                    <button
                      onClick={() =>
                        setPicked((prev) => {
                          const next = new Map(prev);
                          next.delete(p.id);
                          return next;
                        })
                      }
                      className="text-xs text-blue-700 hover:text-red-700 px-2 py-1 cursor-pointer"
                    >
                      {t("remove")}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Browse Eventor events */}
          <div className="px-6 py-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-1">
              {t("browseHeading")}
            </h3>
            <p className="text-xs text-slate-500 mb-3">{t("browseHelp")}</p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  {t("dateWindow")}
                </label>
                <input
                  type="range"
                  min={1}
                  max={120}
                  step={1}
                  value={daysAround}
                  onChange={(e) => setDaysAround(parseInt(e.target.value, 10))}
                  className="w-full"
                />
                <div className="text-xs text-slate-500">
                  {t("daysAroundLabel", { days: daysAround })} ({eventDate})
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  {t("classification")}
                </label>
                <select
                  value={classification ?? ""}
                  onChange={(e) =>
                    setClassification(e.target.value ? parseInt(e.target.value, 10) : null)
                  }
                  className="w-full text-sm border border-slate-200 rounded-lg px-2 py-1.5"
                >
                  <option value="">{t("classificationAll")}</option>
                  {[1, 2, 3, 4, 5, 6].map((id) => (
                    <option key={id} value={id}>
                      {tDynamic(t, CLASSIFICATION_KEYS[id])}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchEvents")}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 mb-3"
            />

            <div className="min-h-[10rem]">
              {eventsQuery.isLoading ? (
                <div className="text-sm text-slate-500 py-6 text-center">
                  {t("loadingEvents")}
                </div>
              ) : eventsQuery.error ? (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  {browseErrorMessage}
                </div>
              ) : filteredEvents.length === 0 ? (
                <div className="text-sm text-slate-500 py-6 text-center">
                  {t("noEventsFound")}
                </div>
              ) : (
                <ul className="divide-y divide-slate-100 border border-slate-100 rounded-lg">
                  {filteredEvents.map((e) => {
                    const isAlreadyAdded = alreadySelected.has(e.id);
                    const isPicked = picked.has(e.id);
                    return (
                      <li key={e.id}>
                        <label
                          className={`flex items-start gap-3 py-2 px-3 cursor-pointer ${isAlreadyAdded ? "opacity-50 cursor-not-allowed" : "hover:bg-slate-50"}`}
                        >
                          <input
                            type="checkbox"
                            checked={isPicked || isAlreadyAdded}
                            disabled={isAlreadyAdded}
                            onChange={() => togglePick(e)}
                            className="mt-0.5"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-slate-900 truncate">
                              {e.name}
                            </div>
                            <div className="text-xs text-slate-500 truncate">
                              {e.date} · {e.organiserName} ·{" "}
                              {tDynamic(
                                t,
                                CLASSIFICATION_KEYS[e.classificationId] ??
                                  "classificationAll",
                              )}
                            </div>
                          </div>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-200 flex items-center justify-between bg-slate-50 rounded-b-2xl">
          <span className="text-xs text-slate-500">
            {picked.size > 0 ? t("selected", { count: picked.size }) : ""}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 rounded-lg cursor-pointer"
            >
              {t("cancel")}
            </button>
            <button
              onClick={() => onConfirm([...picked.values()])}
              disabled={picked.size === 0}
              className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed cursor-pointer"
            >
              {t("addSelected")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
