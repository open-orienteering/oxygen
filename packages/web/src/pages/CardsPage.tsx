import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { formatMeosTime } from "@oxygen/shared";
import { StatusBadge } from "../components/StatusBadge";
import { SortHeader } from "../components/SortHeader";
import { ClubLogo } from "../components/ClubLogo";
import { useSort } from "../hooks/useSort";
import { useNumericSearchParam } from "../hooks/useSearchParam";
import { getCardType } from "../lib/si-protocol";
import { CardTypeBadge } from "../components/CardTypeBadge";
import { StructuredSearchBar } from "../components/structured-search/StructuredSearchBar";
import { useStructuredSearch } from "../hooks/useStructuredSearch";
import { createCardAnchors, type CardListItem } from "../lib/structured-search/anchors/card-anchors";

// ─── Battery voltage thresholds (from sportident-python) ────
const BATTERY_LOW = 2.5; // RED — replace battery!
const BATTERY_WARN = 2.7; // YELLOW — getting low

function batteryColor(volts: number): string {
  if (volts < BATTERY_LOW) return "text-red-600 font-bold";
  if (volts < BATTERY_WARN) return "text-amber-600 font-semibold";
  return "text-emerald-600";
}

function batteryLabelKey(volts: number): "batteryLowReplace" | "batteryGettingLow" | "batteryOk" {
  if (volts < BATTERY_LOW) return "batteryLowReplace";
  if (volts < BATTERY_WARN) return "batteryGettingLow";
  return "batteryOk";
}

function batteryBgColor(volts: number): string {
  if (volts < BATTERY_LOW) return "bg-red-50";
  if (volts < BATTERY_WARN) return "bg-amber-50";
  return "bg-emerald-50";
}

// ─── Battery Cell (for table column) ────────────────────────

function BatteryCell({ voltage, cardType }: { voltage: number | null; cardType: string }) {
  const { t } = useTranslation("devices");
  const isSIAC = cardType === "SIAC";
  if (!isSIAC) return <span className="text-slate-200">—</span>;
  if (voltage == null || voltage <= 0) {
    return (
      <span className="text-slate-300 text-xs italic" title={t("notMeasured")}>
        —
      </span>
    );
  }

  return (
    <span
      className={`font-mono text-xs ${batteryColor(voltage)}`}
      title={`${voltage.toFixed(2)}V — ${t(batteryLabelKey(voltage))}`}
    >
      {voltage.toFixed(2)}V
    </span>
  );
}

// ─── Main Page ──────────────────────────────────────────────

export function CardsPage() {
  const { t } = useTranslation("devices");
  const [expandedCard, setExpandedCard] = useNumericSearchParam("card");

  const cards = trpc.cardReadout.cardList.useQuery();
  const dashboard = trpc.competition.dashboard.useQuery();
  const clubs = trpc.competition.clubs.useQuery();

  const anchors = useMemo(() => createCardAnchors((key) => t(key as never)), [t]);
  const { tokens, setTokens, filterItems } = useStructuredSearch<CardListItem>(
    anchors,
    [],
  );

  const suggestionData = useMemo(
    () => ({
      classes: dashboard.data?.classes.map((c) => ({ id: c.id, name: c.name })) ?? [],
      clubs: clubs.data?.map((c) => ({ id: c.id, name: c.name })) ?? [],
    }),
    [dashboard.data, clubs.data],
  );

  type Card = NonNullable<typeof cards.data>[number];

  const comparators = useMemo(
    () => ({
      cardNo: (a: Card, b: Card) => a.cardNo - b.cardNo,
      type: (a: Card, b: Card) => a.cardType.localeCompare(b.cardType),
      battery: (a: Card, b: Card) =>
        (a.batteryVoltage ?? -1) - (b.batteryVoltage ?? -1),
      runner: (a: Card, b: Card) =>
        (a.runner?.name ?? "").localeCompare(b.runner?.name ?? ""),
      club: (a: Card, b: Card) =>
        (a.runner?.clubName ?? "").localeCompare(b.runner?.clubName ?? ""),
      class: (a: Card, b: Card) =>
        (a.runner?.className ?? "").localeCompare(b.runner?.className ?? ""),
      punches: (a: Card, b: Card) => a.punchCount - b.punchCount,
      modified: (a: Card, b: Card) =>
        (a.modified ?? "").localeCompare(b.modified ?? ""),
    }),
    [],
  );

  const filtered = useMemo(
    () => filterItems((cards.data ?? []) as CardListItem[]),
    [cards.data, filterItems],
  );

  const { sorted, sort, toggle } = useSort(
    filtered,
    { key: "cardNo", dir: "asc" },
    comparators,
  );

  const handleCardClick = (cardNo: number) => {
    setExpandedCard(expandedCard === cardNo ? undefined : cardNo);
  };

  const colCount = 8;

  return (
    <>
      {/* Search */}
      <div className="mb-4">
        <StructuredSearchBar
          tokens={tokens}
          onTokensChange={setTokens}
          anchors={anchors}
          placeholder={t("searchCards")}
          suggestionData={suggestionData}
        />
      </div>
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-slate-500">
          {tokens.length > 0
            ? `${filtered.length} / ${cards.data?.length ?? 0}`
            : t("cardsCount", { count: cards.data?.length ?? 0 })}
        </span>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <SortHeader label={t("cardNo")} active={sort.key === "cardNo"} direction={sort.dir} onClick={() => toggle("cardNo")} />
              <SortHeader label={t("type")} active={sort.key === "type"} direction={sort.dir} onClick={() => toggle("type")} />
              <SortHeader label={t("battery")} active={sort.key === "battery"} direction={sort.dir} onClick={() => toggle("battery")} />
              <SortHeader label={t("runner")} active={sort.key === "runner"} direction={sort.dir} onClick={() => toggle("runner")} />
              <SortHeader label={t("club")} active={sort.key === "club"} direction={sort.dir} onClick={() => toggle("club")} />
              <SortHeader label={t("class")} active={sort.key === "class"} direction={sort.dir} onClick={() => toggle("class")} />
              <SortHeader label={t("punches")} active={sort.key === "punches"} direction={sort.dir} onClick={() => toggle("punches")} />
              <SortHeader label={t("modified")} active={sort.key === "modified"} direction={sort.dir} onClick={() => toggle("modified")} />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {cards.isLoading ? (
              <tr>
                <td colSpan={colCount} className="py-12 text-center text-slate-400">
                  {t("loading")}
                </td>
              </tr>
            ) : sorted.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="py-12 text-center text-slate-400">
                  {t("noCardsFound")}
                </td>
              </tr>
            ) : (
              sorted.map((card) => (
                <Fragment key={card.id}>
                  <tr
                    onClick={() => handleCardClick(card.cardNo)}
                    className={`cursor-pointer hover:bg-slate-50 transition-colors ${expandedCard === card.cardNo ? "bg-blue-50" : ""
                      }`}
                  >
                    <td className="px-4 py-3 font-mono font-medium text-slate-800">
                      {card.cardNo}
                    </td>
                    <td className="px-4 py-3">
                      <CardTypeBadge type={card.cardType || getCardType(card.cardNo)} />
                    </td>
                    <td className="px-4 py-3">
                      <BatteryCell
                        voltage={card.batteryVoltage}
                        cardType={card.cardType || getCardType(card.cardNo)}
                      />
                    </td>
                    <td className="px-4 py-3">
                      {card.runner ? (
                        <div className="flex items-center gap-2">
                          <span className="text-slate-800">
                            {card.runner.name}
                          </span>
                          {card.runner.status > 0 && (
                            <StatusBadge status={card.runner.status as any} />
                          )}
                          {card.runner.isRentalCard && (
                            <span
                              title={card.runner.cardReturned ? t("returned") : t("notReturned")}
                              className={`inline-flex items-center text-xs font-semibold px-1.5 py-0.5 rounded ${
                                card.runner.cardReturned
                                  ? "bg-emerald-50 text-emerald-600 border border-emerald-200"
                                  : "bg-amber-50 text-amber-600 border border-amber-200"
                              }`}
                            >
                              {card.runner.cardReturned ? "✓" : "!"}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-amber-600 text-xs font-medium">
                          {t("unlinked")}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {card.runner?.clubName ? (
                        <span className="inline-flex items-center gap-1.5">
                          <ClubLogo clubId={card.runner.clubId} size="sm" />
                          {card.runner.clubName}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {card.runner?.className || "—"}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-600">
                      {card.punchCount > 0 ? (
                        <span className="font-medium">{card.punchCount}</span>
                      ) : (
                        <span className="text-slate-300">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400">
                      {card.modified
                        ? new Date(card.modified).toLocaleString("sv-SE", {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                        : "—"}
                    </td>
                  </tr>
                  {expandedCard === card.cardNo && (
                    <tr key={`${card.cardNo}-detail`}>
                      <td colSpan={colCount} className="p-0">
                        <CardDetailPanel cardNo={card.cardNo} onReturnToggled={() => cards.refetch()} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─── Battery Detail Block (for detail panel) ────────────────

interface BatteryDetailProps {
  /** Battery voltage in volts, or null when not measured. */
  batteryVoltage: number | null;
  metadata?: {
    batteryDate?: string;
    productionDate?: string;
    hardwareVersion?: string;
    softwareVersion?: string;
    clearCount?: number;
  } | null;
}

function BatteryDetailBlock({ batteryVoltage, metadata }: BatteryDetailProps) {
  const { t } = useTranslation("devices");
  const volts = batteryVoltage != null && batteryVoltage > 0 ? batteryVoltage : 0;

  return (
    <div>
      <h4 className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">
        {t("batteryAndCardInfo")}
      </h4>
      <dl className="space-y-1 text-sm">
        {/* Voltage with status indicator */}
        <div className="flex gap-2 items-center">
          <dt className="text-slate-500 w-28">{t("voltage")}:</dt>
          <dd>
            {volts > 0 ? (
              <span className="inline-flex items-center gap-2">
                <span className={`font-mono font-medium ${batteryColor(volts)}`}>
                  {volts.toFixed(2)}V
                </span>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${batteryBgColor(volts)} ${batteryColor(volts)}`}
                >
                  {t(batteryLabelKey(volts))}
                </span>
              </span>
            ) : (
              <span className="text-slate-400 text-xs italic">
                {t("notMeasured")}
              </span>
            )}
          </dd>
        </div>

        {/* Battery date */}
        {metadata?.batteryDate && (
          <div className="flex gap-2">
            <dt className="text-slate-500 w-28">{t("batteryDate")}:</dt>
            <dd className="font-mono text-slate-700">{metadata.batteryDate}</dd>
          </div>
        )}

        {/* Production date */}
        {metadata?.productionDate && (
          <div className="flex gap-2">
            <dt className="text-slate-500 w-28">{t("produced")}:</dt>
            <dd className="font-mono text-slate-700">{metadata.productionDate}</dd>
          </div>
        )}

        {/* Hardware version */}
        {metadata?.hardwareVersion && (
          <div className="flex gap-2">
            <dt className="text-slate-500 w-28">{t("hwVersion")}:</dt>
            <dd className="font-mono text-slate-700">{metadata.hardwareVersion}</dd>
          </div>
        )}

        {/* Software version */}
        {metadata?.softwareVersion && (
          <div className="flex gap-2">
            <dt className="text-slate-500 w-28">{t("swVersion")}:</dt>
            <dd className="font-mono text-slate-700">{metadata.softwareVersion}</dd>
          </div>
        )}

        {/* Clear count */}
        {metadata?.clearCount != null && (
          <div className="flex gap-2">
            <dt className="text-slate-500 w-28">{t("clearCount")}:</dt>
            <dd className="font-mono text-slate-700">{metadata.clearCount}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

// ─── Card Detail Panel ──────────────────────────────────────

function CardDetailPanel({ cardNo, onReturnToggled }: { cardNo: number; onReturnToggled?: () => void }) {
  const { t } = useTranslation("devices");
  const detail = trpc.cardReadout.cardDetail.useQuery({ cardNo });
  const history = trpc.cardReadout.readoutHistory.useQuery({ cardNo });

  const [isLinking, setIsLinking] = useState(false);
  const [runnerSearch, setRunnerSearch] = useState("");

  const setCardReturned = trpc.runner.setCardReturned.useMutation({
    onSuccess: () => {
      detail.refetch();
      onReturnToggled?.();
    },
  });

  const linkMutation = trpc.cardReadout.linkCardToRunner.useMutation({
    onSuccess: () => {
      detail.refetch();
      onReturnToggled?.();
      setIsLinking(false);
      setRunnerSearch("");
    },
  });

  const runnerResults = trpc.runner.list.useQuery(
    { search: runnerSearch },
    { enabled: isLinking && runnerSearch.length >= 2 },
  );

  if (detail.isLoading) {
    return (
      <div className="p-6 text-center text-slate-400">{t("loadingDetails")}</div>
    );
  }
  if (detail.isError) {
    return (
      <div className="p-6 text-center text-red-500">
        {t("errorLoadingCard", { message: detail.error?.message ?? t("unknownError") })}
      </div>
    );
  }
  if (!detail.data) {
    return (
      <div className="p-6 text-center text-slate-400">{t("cardNotFoundInDb")}</div>
    );
  }

  const d = detail.data;
  const cardType = d.cardType || (d.cardNo > 0 ? getCardType(d.cardNo) : "Unknown");
  const isSIAC = cardType === "SIAC";

  return (
    <div className="bg-slate-50/50 border-t border-slate-200 p-5 space-y-5">
      {/* Card Info + Runner */}
      <div className="grid grid-cols-2 gap-6">
        <div>
          <h4 className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">
            {t("cardInformation")}
          </h4>
          <dl className="space-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-slate-500 w-20">{t("number")}:</dt>
              <dd className="font-mono font-medium">{d.cardNo}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-slate-500 w-20">{t("type")}:</dt>
              <dd><CardTypeBadge type={String(cardType)} /></dd>
            </div>
            {(d.ownerData as any) && (
              <>
                {((d.ownerData as any).firstName || (d.ownerData as any).lastName) && (
                  <div className="flex gap-2">
                    <dt className="text-slate-500 w-20">{t("owner")}:</dt>
                    <dd>
                      {[(d.ownerData as any).firstName, (d.ownerData as any).lastName]
                        .filter(Boolean)
                        .join(" ")}
                    </dd>
                  </div>
                )}
                {(d.ownerData as any).club && (
                  <div className="flex gap-2">
                    <dt className="text-slate-500 w-20">{t("club")}:</dt>
                    <dd>{(d.ownerData as any).club}</dd>
                  </div>
                )}
                {(d.ownerData as any).country && (
                  <div className="flex gap-2">
                    <dt className="text-slate-500 w-20">{t("countryLabel")}:</dt>
                    <dd>{(d.ownerData as any).country}</dd>
                  </div>
                )}
              </>
            )}
          </dl>
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-medium text-slate-500 uppercase tracking-wider">
              {t("linkedRunner")}
            </h4>
            <div className="flex gap-1.5">
              {d.runner && !isLinking && (
                <>
                  <button
                    onClick={() => setIsLinking(true)}
                    className="text-xs text-blue-600 hover:text-blue-800 font-medium cursor-pointer"
                  >
                    {t("changeRunner")}
                  </button>
                  <span className="text-slate-300">·</span>
                  <button
                    onClick={() => {
                      if (window.confirm(t("confirmUnlink", { runner: d.runner!.name, cardNo: d.cardNo }))) {
                        linkMutation.mutate({ cardId: d.id, runnerId: null });
                      }
                    }}
                    disabled={linkMutation.isPending}
                    className="text-xs text-red-500 hover:text-red-700 font-medium cursor-pointer disabled:opacity-50"
                  >
                    {t("unlinkRunner")}
                  </button>
                </>
              )}
              {!d.runner && !isLinking && (
                <button
                  onClick={() => setIsLinking(true)}
                  className="text-xs text-blue-600 hover:text-blue-800 font-medium cursor-pointer"
                >
                  {t("linkRunner")}
                </button>
              )}
              {isLinking && (
                <button
                  onClick={() => { setIsLinking(false); setRunnerSearch(""); }}
                  className="text-xs text-slate-500 hover:text-slate-700 font-medium cursor-pointer"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
          {d.runner && !isLinking ? (
            <dl className="space-y-1 text-sm">
              <div className="flex gap-2">
                <dt className="text-slate-500 w-20">{t("name")}:</dt>
                <dd className="font-medium">{d.runner.name}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-slate-500 w-20">{t("club")}:</dt>
                <dd>
                  {d.runner.clubName ? (
                    <span className="inline-flex items-center gap-1.5">
                      <ClubLogo clubId={d.runner.clubId} size="sm" />
                      {d.runner.clubName}
                    </span>
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-slate-500 w-20">{t("class")}:</dt>
                <dd>{d.runner.className || "—"}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-slate-500 w-20">{t("status")}:</dt>
                <dd>
                  <StatusBadge status={d.runner.status as any} />
                </dd>
              </div>
            </dl>
          ) : isLinking ? (
            <div className="space-y-2">
              <input
                type="text"
                value={runnerSearch}
                onChange={(e) => setRunnerSearch(e.target.value)}
                placeholder={t("searchRunnerPlaceholder")}
                className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
              />
              {runnerSearch.length < 2 ? (
                <p className="text-xs text-slate-400 px-1">{t("typeToSearch")}</p>
              ) : runnerResults.isLoading ? (
                <p className="text-xs text-slate-400 px-1">{t("loading")}</p>
              ) : (runnerResults.data ?? []).length === 0 ? (
                <p className="text-xs text-slate-400 px-1">{t("noRunnersFound")}</p>
              ) : (
                <div className="border border-slate-200 rounded-lg bg-white max-h-48 overflow-y-auto divide-y divide-slate-50">
                  {(runnerResults.data ?? []).slice(0, 20).map((r) => (
                    <button
                      key={r.id}
                      onClick={() => {
                        if (window.confirm(t("confirmLink", { runner: r.name, cardNo: d.cardNo }))) {
                          linkMutation.mutate({ cardId: d.id, runnerId: r.id });
                        }
                      }}
                      disabled={linkMutation.isPending}
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-blue-50 transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-between"
                    >
                      <span className="font-medium text-slate-800">{r.name}</span>
                      <span className="text-xs text-slate-400">
                        {r.className}{r.clubName ? ` · ${r.clubName}` : ""}
                        {r.cardNo > 0 ? ` · #${r.cardNo}` : ""}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {linkMutation.isPending && (
                <p className="text-xs text-blue-600 px-1">{t("linking")}</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-amber-600">
              {t("notLinkedToRunner")}
            </p>
          )}
        </div>
      </div>

      {/* Rental card section */}
      {d.runner?.isRentalCard && (
        <div className={`rounded-xl px-5 py-4 flex items-center justify-between gap-4 border-2 ${
          d.runner.cardReturned
            ? "bg-emerald-50 border-emerald-200"
            : "bg-amber-50 border-amber-300"
        }`}>
          <div className="flex items-center gap-3">
            <svg className={`w-5 h-5 shrink-0 ${d.runner.cardReturned ? "text-emerald-600" : "text-amber-600"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
            </svg>
            <div>
              <span className={`text-sm font-semibold ${d.runner.cardReturned ? "text-emerald-700" : "text-amber-800"}`}>
                {t("rentalCard")}
              </span>
              <span className={`ml-2 text-xs px-2 py-0.5 rounded-full font-medium ${
                d.runner.cardReturned
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-amber-100 text-amber-700"
              }`}>
                {d.runner.cardReturned ? t("returned") : t("notReturned")}
              </span>
            </div>
          </div>
          <button
            onClick={() => setCardReturned.mutate({ runnerId: d.runner!.id, returned: !d.runner!.cardReturned })}
            disabled={setCardReturned.isPending}
            className={`shrink-0 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer disabled:opacity-50 ${
              d.runner.cardReturned
                ? "bg-slate-100 text-slate-700 hover:bg-slate-200"
                : "bg-amber-600 text-white hover:bg-amber-700"
            }`}
          >
            {d.runner.cardReturned ? t("markNotReturned") : t("markReturned")}
          </button>
        </div>
      )}

      {/* Battery & Card Info (SIAC only) */}
      {isSIAC && (
        <BatteryDetailBlock batteryVoltage={d.batteryVoltage} metadata={d.metadata as any} />
      )}

      {/* Current Readout */}
      <div>
        <h4 className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">
          {t("currentReadout", { count: d.punches.length })}
        </h4>
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          {d.punches.length === 0 && !d.startTime && !d.finishTime ? (
            <div className="p-4 text-sm text-slate-400 text-center">
              {t("noReadoutData")}
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <th className="px-3 py-1.5 text-left font-medium text-slate-500">
                    #
                  </th>
                  <th className="px-3 py-1.5 text-left font-medium text-slate-500">
                    {t("controlHeader")}
                  </th>
                  <th className="px-3 py-1.5 text-left font-medium text-slate-500">
                    {t("timeHeader")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {d.checkTime != null && d.checkTime > 0 && (
                  <tr className="text-slate-400">
                    <td className="px-3 py-1" />
                    <td className="px-3 py-1 italic">{t("check")}</td>
                    <td className="px-3 py-1 font-mono">
                      {formatMeosTime(d.checkTime)}
                    </td>
                  </tr>
                )}
                {d.startTime != null && d.startTime > 0 && (
                  <tr className="text-emerald-600">
                    <td className="px-3 py-1" />
                    <td className="px-3 py-1 font-medium">{t("start")}</td>
                    <td className="px-3 py-1 font-mono">
                      {formatMeosTime(d.startTime)}
                    </td>
                  </tr>
                )}
                {d.punches.map((p, i) => (
                  <tr key={i}>
                    <td className="px-3 py-1 text-slate-400">{i + 1}</td>
                    <td className="px-3 py-1 font-mono font-medium">
                      {p.controlCode}
                    </td>
                    <td className="px-3 py-1 font-mono">
                      {formatMeosTime(p.time)}
                    </td>
                  </tr>
                ))}
                {d.finishTime != null && d.finishTime > 0 && (
                  <tr className="text-blue-600 font-medium">
                    <td className="px-3 py-1" />
                    <td className="px-3 py-1">{t("finish")}</td>
                    <td className="px-3 py-1 font-mono">
                      {formatMeosTime(d.finishTime)}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Readout History */}
      {history.data && history.data.length > 0 && (
        <ReadoutHistorySection history={history.data as any} />
      )}
    </div>
  );
}

// ─── Parse MeOS punch string ────────────────────────────────

interface ParsedPunchEntry {
  type: number;
  time: number; // deciseconds
}

function parseMeosPunches(punchString: string): ParsedPunchEntry[] {
  if (!punchString) return [];
  const punches: ParsedPunchEntry[] = [];
  for (const part of punchString.split(";").filter(Boolean)) {
    const dashIdx = part.indexOf("-");
    if (dashIdx === -1) continue;
    const type = parseInt(part.substring(0, dashIdx), 10);
    let timeStr = part.substring(dashIdx + 1);
    const atIdx = timeStr.indexOf("@");
    if (atIdx !== -1) timeStr = timeStr.substring(0, atIdx);
    const hashIdx = timeStr.indexOf("#");
    if (hashIdx !== -1) timeStr = timeStr.substring(0, hashIdx);
    const dotIdx = timeStr.indexOf(".");
    let time: number;
    if (dotIdx !== -1) {
      time =
        parseInt(timeStr.substring(0, dotIdx), 10) * 10 +
        (parseInt(timeStr.substring(dotIdx + 1), 10) || 0);
    } else {
      time = parseInt(timeStr, 10) * 10;
    }
    if (!isNaN(type) && !isNaN(time)) punches.push({ type, time });
  }
  return punches;
}

// ─── Readout History Section ────────────────────────────────

type HistoryEntry = {
  id: number;
  cardNo: number;
  cardType: string;
  punches: string;
  /** Battery voltage in volts, or null when not measured. */
  batteryVoltage: number | null;
  ownerData: { firstName?: string; lastName?: string; club?: string } | null;
  metadata: {
    batteryDate?: string;
    productionDate?: string;
    hardwareVersion?: string;
    softwareVersion?: string;
    clearCount?: number;
  } | null;
  readAt: string;
};

function HistoryBatteryIndicator({ batteryVoltage }: { batteryVoltage: number | null }) {
  const { t } = useTranslation("devices");
  if (batteryVoltage == null || batteryVoltage <= 0) return null;
  const volts = batteryVoltage;

  return (
    <span
      className={`text-[10px] font-mono ${batteryColor(volts)}`}
      title={`${t("battery")}: ${volts.toFixed(2)}V — ${t(batteryLabelKey(volts))}`}
    >
      {volts.toFixed(2)}V
    </span>
  );
}

function ReadoutHistorySection({ history }: { history: HistoryEntry[] }) {
  const { t } = useTranslation("devices");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  return (
    <div>
      <h4 className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">
        {t("readoutHistory", { count: history.length })}
      </h4>
      <div className="space-y-2">
        {history.map((h) => {
          const allPunches = parseMeosPunches(h.punches);
          const isExpanded = expandedId === h.id;
          const checkPunch = allPunches.find((p) => p.type === 3);
          const startPunch = allPunches.find((p) => p.type === 1);
          const finishPunch = allPunches.find((p) => p.type === 2);
          const controlPunches = allPunches.filter(
            (p) => p.type !== 1 && p.type !== 2 && p.type !== 3,
          );

          return (
            <div key={h.id} className="bg-white rounded-lg border border-slate-200 overflow-hidden">
              {/* Summary row — clickable */}
              <button
                onClick={() => setExpandedId(isExpanded ? null : h.id)}
                className="w-full px-4 py-2 flex items-center justify-between text-sm hover:bg-slate-50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <svg
                    className={`w-3.5 h-3.5 text-slate-400 transition-transform ${isExpanded ? "rotate-90" : ""
                      }`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                  <span className="text-xs text-slate-400 tabular-nums">
                    {new Date(h.readAt).toLocaleString("sv-SE", {
                      year: "numeric",
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  {h.cardType && (
                    <CardTypeBadge type={h.cardType} />
                  )}
                  <span className="text-slate-600">
                    {t("punchesLabel", { count: controlPunches.length })}
                  </span>
                  {h.batteryVoltage != null && h.batteryVoltage > 0 && (
                    <HistoryBatteryIndicator batteryVoltage={h.batteryVoltage} />
                  )}
                  {h.ownerData &&
                    (h.ownerData.firstName || h.ownerData.lastName) && (
                      <span className="text-slate-400 text-xs">
                        {t("ownerLabel", { name: [h.ownerData.firstName, h.ownerData.lastName].filter(Boolean).join(" ") })}
                      </span>
                    )}
                </div>
              </button>

              {/* Expanded punch detail */}
              {isExpanded && (
                <div className="border-t border-slate-100 p-3">
                  {allPunches.length === 0 ? (
                    <p className="text-xs text-slate-400 text-center py-2">
                      {t("noPunchData")}
                    </p>
                  ) : (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-slate-400">
                          <th className="px-2 py-1 text-left w-10">#</th>
                          <th className="px-2 py-1 text-left">{t("controlHeader")}</th>
                          <th className="px-2 py-1 text-left">{t("timeHeader")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {checkPunch && (
                          <tr className="text-slate-400">
                            <td className="px-2 py-1" />
                            <td className="px-2 py-1 italic">{t("check")}</td>
                            <td className="px-2 py-1 font-mono">
                              {formatMeosTime(checkPunch.time)}
                            </td>
                          </tr>
                        )}
                        {startPunch && (
                          <tr className="text-emerald-600">
                            <td className="px-2 py-1" />
                            <td className="px-2 py-1 font-medium">{t("start")}</td>
                            <td className="px-2 py-1 font-mono">
                              {formatMeosTime(startPunch.time)}
                            </td>
                          </tr>
                        )}
                        {controlPunches.map((p, i) => (
                          <tr key={i}>
                            <td className="px-2 py-1 text-slate-400">
                              {i + 1}
                            </td>
                            <td className="px-2 py-1 font-mono font-medium">
                              {p.type}
                            </td>
                            <td className="px-2 py-1 font-mono">
                              {formatMeosTime(p.time)}
                            </td>
                          </tr>
                        ))}
                        {finishPunch && (
                          <tr className="text-blue-600 font-medium">
                            <td className="px-2 py-1" />
                            <td className="px-2 py-1">{t("finish")}</td>
                            <td className="px-2 py-1 font-mono">
                              {formatMeosTime(finishPunch.time)}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  )}

                  {/* Metadata for this readout */}
                  {h.metadata && (
                    <div className="mt-2 pt-2 border-t border-slate-100 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-400">
                      {h.metadata.batteryDate && (
                        <span>{t("batteryDateLabel", { date: h.metadata.batteryDate })}</span>
                      )}
                      {h.metadata.productionDate && (
                        <span>{t("producedLabel", { date: h.metadata.productionDate })}</span>
                      )}
                      {h.metadata.hardwareVersion && (
                        <span>{t("hwLabel", { version: h.metadata.hardwareVersion })}</span>
                      )}
                      {h.metadata.softwareVersion && (
                        <span>{t("swLabel", { version: h.metadata.softwareVersion })}</span>
                      )}
                      {h.metadata.clearCount != null && (
                        <span>{t("clearsLabel", { count: h.metadata.clearCount })}</span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
