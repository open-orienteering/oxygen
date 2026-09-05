import { useState, useEffect, useMemo } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { EventInfo, EventKind } from "@oxygen/shared";
import { trpc } from "../lib/trpc";
import { formatDate } from "../lib/format";
import { formatBuildVersion } from "../lib/app-update";
import { LanguageSelector } from "../components/LanguageSelector";
import { UserChip } from "../components/UserChip";
import {
  EVENT_KIND_OPTIONS,
  eventKindDisplayLabel,
  eventKindLabelKey,
  filterEvents,
  groupEvents,
  type EventKindFilter,
} from "../lib/event-list";

export function CompetitionSelector() {
  const navigate = useNavigate();
  const { t } = useTranslation("event");
  const competitions = trpc.competition.list.useQuery();
  const selectMutation = trpc.competition.select.useMutation({
    onSuccess: (data) => {
      navigate(`/${data.nameId}`);
    },
  });

  const [deleteConfirm, setDeleteConfirm] = useState<{ nameId: string; name: string } | null>(null);
  const deleteMutation = trpc.competition.delete.useMutation({
    onSuccess: () => {
      setDeleteConfirm(null);
      competitions.refetch();
    },
  });

  const [showCreate, setShowCreate] = useState(false);
  const [showEventor, setShowEventor] = useState(false);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<EventKindFilter>("all");

  const events = useMemo(() => competitions.data ?? [], [competitions.data]);
  const filtered = useMemo(
    () => filterEvents(events, { query: search, kind }),
    [events, search, kind],
  );
  const grouped = useMemo(() => groupEvents(filtered, formatDate(new Date())), [filtered]);
  const hasFilters = search.trim() !== "" || kind !== "all";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        {/* Language Selector — top right */}
        <div className="flex justify-end mb-2 items-center gap-3">
          <UserChip />
          <LanguageSelector />
        </div>

        {/* Logo / Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-600 text-white text-2xl font-bold mb-4 shadow-lg">
            O2
          </div>
          <h1 className="text-3xl font-bold text-slate-900">
            {t("title")}
          </h1>
          <p className="text-slate-500 mt-2">{t("selectCompetition")}</p>
        </div>

        {/* Competition List */}
        <div className="bg-white rounded-2xl shadow-lg border border-slate-200 overflow-hidden">
          {competitions.isLoading && (
            <div className="p-12 text-center">
              <div className="inline-block w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
              <p className="text-slate-500 mt-4">{t("loadingCompetitions")}</p>
            </div>
          )}

          {competitions.isError && (
            <div className="p-8 text-center">
              <div className="text-red-500 text-lg font-medium mb-2">
                {t("connectionError")}
              </div>
              <p className="text-slate-500 text-sm mb-4">
                {t("couldNotConnect")}
                <br />
                {t("ensureRunning")}
              </p>
              <button
                onClick={() => competitions.refetch()}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors cursor-pointer"
              >
                {t("retry", { ns: "common" })}
              </button>
            </div>
          )}

          {competitions.data && competitions.data.length === 0 && (
            <div className="p-8 text-center text-slate-500">
              {t("noCompetitions")}
            </div>
          )}

          {competitions.data && competitions.data.length > 0 && (
            <>
              <div className="flex gap-2 p-3 border-b border-slate-100">
                <input
                  type="search"
                  data-testid="event-search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("searchPlaceholder")}
                  className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <select
                  data-testid="event-type-filter"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as EventKindFilter)}
                  className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="all">{t("typeFilterAll")}</option>
                  {EVENT_KIND_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {t(eventKindLabelKey(option))}
                    </option>
                  ))}
                </select>
              </div>
              {filtered.length === 0 ? (
                <div className="p-8 text-center text-slate-500">
                  <p>{t("noMatches")}</p>
                  {hasFilters && (
                    <button
                      type="button"
                      data-testid="clear-event-filters"
                      onClick={() => {
                        setSearch("");
                        setKind("all");
                      }}
                      className="mt-3 text-sm text-blue-600 hover:text-blue-800 cursor-pointer"
                    >
                      {t("clearFilters")}
                    </button>
                  )}
                </div>
              ) : (
                <EventList
                  upcoming={grouped.upcoming}
                  past={grouped.past}
                  onDelete={(comp) =>
                    setDeleteConfirm({ nameId: comp.nameId, name: comp.name })
                  }
                />
              )}
            </>
          )}
        </div>

        {selectMutation.isError && (
          <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">
            {t("failedToConnect", { message: selectMutation.error.message })}
          </div>
        )}

        {/* Action buttons */}
        <div className="mt-6 flex gap-3">
          <button
            onClick={() => { setShowCreate(true); setShowEventor(false); }}
            className="flex-1 px-4 py-3 bg-white border border-slate-200 rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors cursor-pointer flex items-center justify-center gap-2 shadow-sm"
          >
            <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            {t("newCompetition")}
          </button>
          <button
            onClick={() => { setShowEventor(true); setShowCreate(false); }}
            className="flex-1 px-4 py-3 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 transition-colors cursor-pointer flex items-center justify-center gap-2 shadow-sm"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            {t("importFromEventor")}
          </button>
        </div>
        <div className="mt-3">
          <Link
            to="/settings"
            data-testid="settings-link"
            className="flex w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors items-center justify-center gap-2 shadow-sm"
          >
            <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {t("settingsLink", { ns: "common" })}
          </Link>
        </div>

        {/* Create new competition form */}
        {showCreate && (
          <CreateCompetitionForm
            onClose={() => setShowCreate(false)}
            onCreated={(nameId) => {
              competitions.refetch();
              setShowCreate(false);
              navigate(`/${nameId}`);
            }}
          />
        )}

        {/* Eventor import panel */}
        {showEventor && (
          <EventorImportPanel
            onClose={() => setShowEventor(false)}
            onImported={(nameId) => {
              competitions.refetch();
              setShowEventor(false);
              navigate(`/${nameId}`);
            }}
          />
        )}

        {/* Delete confirmation dialog */}
        {deleteConfirm && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
            <div
              data-testid="delete-event-dialog"
              className="bg-white rounded-2xl shadow-xl border border-slate-200 p-6 max-w-sm w-full"
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">{t("deleteCompetition")}</h3>
                  <p className="text-sm text-slate-500">{t("deleteCannotUndo")}</p>
                </div>
              </div>
              <p className="text-sm text-slate-600 mb-1">
                {t("deleteConfirm")}
              </p>
              <p className="text-sm font-semibold text-slate-900 mb-1">
                {deleteConfirm.name}
              </p>
              <p className="text-xs text-slate-400 font-mono mb-3">
                {t("eventId")}: {deleteConfirm.nameId}
              </p>
              <p className="text-xs text-slate-500 mb-5">
                {t("deleteSoftNote")}
              </p>
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => setDeleteConfirm(null)}
                  disabled={deleteMutation.isPending}
                  className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800 cursor-pointer"
                >
                  {t("cancel", { ns: "common" })}
                </button>
                <button
                  data-testid="delete-event-confirm"
                  onClick={() => deleteMutation.mutate({ nameId: deleteConfirm.nameId })}
                  disabled={deleteMutation.isPending}
                  className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  {deleteMutation.isPending ? t("deleting") : t("deletePermanently")}
                </button>
              </div>
              {deleteMutation.isError && (
                <div className="mt-3 text-sm text-red-600">
                  {deleteMutation.error.message}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="text-center mt-6 text-sm text-slate-400 space-y-1">
          <div>{t("footer")}</div>
          <div className="text-xs" data-testid="build-version">
            {t("buildVersion", { ns: "common" })}: {formatBuildVersion(__BUILD_VERSION__)}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Event list (list view; calendar sibling can slot in later) ─

function EventList({
  upcoming,
  past,
  onDelete,
}: {
  upcoming: EventInfo[];
  past: EventInfo[];
  onDelete: (comp: EventInfo) => void;
}) {
  const { t } = useTranslation("event");
  return (
    <div>
      {upcoming.length > 0 && (
        <EventGroup
          title={t("upcoming")}
          testId="event-group-upcoming"
          events={upcoming}
          onDelete={onDelete}
        />
      )}
      {past.length > 0 && (
        <EventGroup
          title={t("past")}
          testId="event-group-past"
          events={past}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}

function EventGroup({
  title,
  testId,
  events,
  onDelete,
}: {
  title: string;
  testId: string;
  events: EventInfo[];
  onDelete: (comp: EventInfo) => void;
}) {
  const { t } = useTranslation("event");
  return (
    <div data-testid={testId}>
      <div className="sticky top-0 z-10 px-4 py-1.5 bg-slate-50/95 backdrop-blur text-[11px] font-semibold uppercase tracking-wider text-slate-500 border-y border-slate-100">
        {title}
      </div>
      <ul className="divide-y divide-slate-100">
        {events.map((comp) => (
          <li key={comp.id}>
            <div className="flex items-center hover:bg-blue-50 transition-colors group">
              <Link
                to={`/${comp.nameId}`}
                className="flex-1 min-w-0 px-4 py-2.5 text-left cursor-pointer"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="font-semibold text-slate-900 group-hover:text-blue-700 transition-colors truncate">
                    {comp.name}
                  </div>
                  <div className="text-sm text-slate-500 tabular-nums flex-shrink-0">
                    {comp.date}
                  </div>
                </div>
                {/* Line 2: event type + badges hug the left; creator stays
                    visible on mobile and truncates against the badges. The
                    internal event slug is intentionally omitted here. */}
                <div className="flex items-center gap-2 mt-0.5 text-xs text-slate-400 min-w-0">
                  <span
                    data-testid="event-type"
                    className="inline-flex items-center px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] font-medium flex-shrink-0"
                  >
                    {eventKindDisplayLabel(comp, (key) => t(key))}
                  </span>
                  {comp.canManage && (
                    <span
                      data-testid="event-manager-badge"
                      className="flex-shrink-0 px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-medium uppercase tracking-wide"
                    >
                      {t("managerBadge")}
                    </span>
                  )}
                  {comp.eventorEnv === "test" && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-bold uppercase tracking-wider flex-shrink-0">
                      {t("testEventor")}
                    </span>
                  )}
                  {comp.annotation && (
                    <span className="hidden sm:block truncate min-w-0">
                      {comp.annotation}
                    </span>
                  )}
                  {comp.owner && (
                    <span
                      data-testid="event-owner"
                      className="ml-auto min-w-0 max-w-[55%] truncate text-right"
                    >
                      {t("eventOwner", { owner: comp.owner })}
                    </span>
                  )}
                </div>
              </Link>
              {/* `event.delete` is gated on `event.manage` server-side;
                  with auth off every row reports canManage. */}
              {comp.canManage && (
                <button
                  data-testid="event-delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(comp);
                  }}
                  className="px-3 py-4 text-slate-300 hover:text-red-500 transition-colors cursor-pointer opacity-0 group-hover:opacity-100"
                  title={t("deleteCompetitionTitle")}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Create Competition Form ────────────────────────────────

function CreateCompetitionForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (nameId: string) => void;
}) {
  const { t } = useTranslation("event");
  const [name, setName] = useState("");
  const [date, setDate] = useState(formatDate(new Date()));
  const [kind, setKind] = useState<EventKind>("competition");
  const [kindCustom, setKindCustom] = useState("");

  const createMutation = trpc.competition.create.useMutation({
    onSuccess: (data) => onCreated(data.nameId),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createMutation.mutate({
      name: name.trim(),
      date,
      kind,
      kindCustom: kind === "other" ? kindCustom.trim() : "",
    });
  };

  return (
    <div className="mt-4 bg-white rounded-2xl shadow-lg border border-slate-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-slate-900">
          {t("newCompetition")}
        </h2>
        <button
          onClick={onClose}
          className="p-1 text-slate-400 hover:text-slate-600 cursor-pointer"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-600 mb-1">
            {t("competitionName")}
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("competitionNamePlaceholder")}
            className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            autoFocus
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-600 mb-1">
            {t("eventType")}
          </label>
          <select
            data-testid="new-event-type"
            value={kind}
            onChange={(e) => setKind(e.target.value as EventKind)}
            className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            {EVENT_KIND_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {t(eventKindLabelKey(option))}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-400">{t("eventTypeHelp")}</p>
        </div>
        {kind === "other" && (
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">
              {t("eventTypeCustom")}
            </label>
            <input
              type="text"
              data-testid="new-event-type-custom"
              value={kindCustom}
              onChange={(e) => setKindCustom(e.target.value)}
              placeholder={t("eventTypeCustomPlaceholder")}
              maxLength={80}
              required
              className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        )}
        <div>
          <label className="block text-sm font-medium text-slate-600 mb-1">
            {t("date", { ns: "common" })}
          </label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            required
          />
        </div>
        <div className="flex gap-3 pt-1">
          <button
            type="submit"
            disabled={
              createMutation.isPending ||
              !name.trim() ||
              (kind === "other" && !kindCustom.trim())
            }
            className="px-6 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors cursor-pointer"
          >
            {createMutation.isPending ? t("creating", { ns: "common" }) : t("create", { ns: "common" })}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-6 py-2.5 text-slate-500 text-sm hover:text-slate-700 cursor-pointer"
          >
            {t("cancel", { ns: "common" })}
          </button>
        </div>
        {createMutation.isError && (
          <div className="text-sm text-red-600">
            {createMutation.error.message}
          </div>
        )}
      </form>
    </div>
  );
}

// ─── Eventor Import Panel ───────────────────────────────────

function EventorImportPanel({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (nameId: string) => void;
}) {
  const { t } = useTranslation("event");
  const [stepOverride, setStepOverride] = useState<"key" | "events" | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [env, setEnv] = useState<"prod" | "test">("prod");

  const keyStatus = trpc.eventor.keyStatus.useQuery({ env });
  const validateMutation = trpc.eventor.validateKey.useMutation({
    onSuccess: () => {
      setStepOverride(null);
      keyStatus.refetch();
    },
  });

  const step = stepOverride || (keyStatus.data?.connected ? "events" : "key");

  // When environment changes, reset the manual step override
  useEffect(() => {
    setStepOverride(null);
  }, [env]);

  const handleValidateKey = (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) return;
    validateMutation.mutate({ apiKey: apiKey.trim(), env });
  };

  return (
    <div className="mt-4 bg-white rounded-2xl shadow-lg border border-blue-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center">
            <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-slate-900">
            {t("importFromEventor")}
          </h2>
        </div>
        <button
          onClick={onClose}
          className="p-1 text-slate-400 hover:text-slate-600 cursor-pointer"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Environment Selector — Always visible */}
      <div className="flex gap-2 mb-4 p-1 bg-slate-100 rounded-lg">
        <button
          onClick={() => setEnv("prod")}
          className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${env === "prod"
            ? "bg-white shadow-sm text-blue-600"
            : "text-slate-500 hover:text-slate-700"
            }`}
        >
          {t("production")}
        </button>
        <button
          onClick={() => setEnv("test")}
          className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${env === "test"
            ? "bg-amber-500 shadow-sm text-white"
            : "text-slate-500 hover:text-slate-700"
            }`}
        >
          {t("testEventor")}
        </button>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-5 text-xs text-slate-400">
        <span
          className={
            step === "key" ? "text-blue-600 font-medium" : "text-green-600"
          }
        >
          {t("apiKeyStep")}
        </span>
        <span>&rarr;</span>
        <span className={step === "events" ? "text-blue-600 font-medium" : ""}>
          {t("selectImportStep")}
        </span>
      </div>


      {/* Step 1: API Key */}
      {step === "key" && (
        <form onSubmit={handleValidateKey} className="space-y-3">
          <p className="text-sm text-slate-500">
            {t("apiKeyPrompt")}
          </p>
          <div>
            <input
              type="text"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t("apiKeyPlaceholder")}
              className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              autoFocus
            />
          </div>
          <button
            type="submit"
            disabled={validateMutation.isPending || !apiKey.trim()}
            className="px-6 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors cursor-pointer"
          >
            {validateMutation.isPending ? t("validating") : t("connect")}
          </button>
          {validateMutation.isError && (
            <div className="text-sm text-red-600">
              {validateMutation.error.message}
            </div>
          )}
        </form>
      )}

      {/* Step 2: Event list with inline import */}
      {step === "events" && (
        <EventorEventList
          env={env}
          orgName={
            keyStatus.data?.connected
              ? keyStatus.data.organisationName ?? ""
              : ""
          }
          onImported={onImported}
          onChangeKey={() => setStepOverride("key")}
        />
      )}
    </div>
  );
}


// ─── Eventor Event List ─────────────────────────────────────

function EventorEventList({
  orgName,
  env,
  onImported,
  onChangeKey,
}: {
  orgName: string;
  env: "prod" | "test";
  onImported: (nameId: string) => void;
  onChangeKey: () => void;
}) {
  const { t } = useTranslation("event");
  const [search, setSearch] = useState("");
  const [importingEventId, setImportingEventId] = useState<number | null>(null);
  const events = trpc.eventor.events.useQuery({ env });

  const importMutation = trpc.eventor.importEvent.useMutation({
    onSettled: () => {
      // Clear importing ID on success or error so buttons reset
      if (!importMutation.isSuccess) {
        setImportingEventId(null);
      }
    },
  });

  const handleImport = (
    eventId: number,
    name: string,
    date: string,
    classificationId: number,
    organiserName?: string,
    organiserId?: number,
  ) => {
    setImportingEventId(eventId);
    importMutation.mutate({
      eventId,
      eventName: name,
      eventDate: date,
      classificationId,
      organiserName,
      organiserId,
      env,
    });
  };

  // Filter events by search term
  const filteredEvents = (events.data ?? []).filter(
    (ev) =>
      !search ||
      ev.name.toLowerCase().includes(search.toLowerCase()) ||
      ev.date.includes(search),
  );

  // If import succeeded, show success and navigate
  if (importMutation.isSuccess && importMutation.data) {
    return (
      <div className="text-center py-4">
        <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
          <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h3 className="text-lg font-semibold text-slate-900 mb-1">
          {t("importComplete")}
        </h3>
        <p className="text-sm text-slate-500 mb-4">
          {t("importSummary", {
            runners: importMutation.data.runnerCount,
            classes: importMutation.data.classCount,
            clubs: importMutation.data.clubCount,
          })}
        </p>
        <button
          onClick={() => onImported(importMutation.data!.nameId)}
          className="px-6 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors cursor-pointer"
        >
          {t("openCompetition")}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Connected info */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-green-600 font-medium flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
          {t("connectedTo", { name: orgName })}
        </span>
        <button
          onClick={onChangeKey}
          className="text-slate-400 hover:text-slate-600 cursor-pointer"
        >
          {t("changeKey")}
        </button>
      </div>

      {/* Search */}
      <div className="relative">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("searchEvents")}
          className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </div>

      {/* Event list */}
      <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-200 divide-y divide-slate-100">
        {events.isLoading && (
          <div className="p-6 text-center">
            <div className="inline-block w-6 h-6 border-3 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
            <p className="text-xs text-slate-400 mt-2">{t("loadingEvents")}</p>
          </div>
        )}

        {events.isError && (
          <div className="p-4 text-center text-red-600 text-sm">
            {events.error.message}
          </div>
        )}

        {filteredEvents.length === 0 && !events.isLoading && !events.isError && (
          <div className="p-6 text-center text-slate-400 text-sm">
            {t("noEventsFound")}
          </div>
        )}

        {filteredEvents.map((ev) => (
          <div
            key={ev.eventId}
            className="px-4 py-3 hover:bg-blue-50 transition-colors"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-slate-900 truncate">
                  {ev.name}
                </div>
                <div className="flex items-center gap-2 mt-1 text-xs text-slate-500">
                  <span>{ev.date}</span>
                  <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 text-[10px] font-medium">
                    {ev.classification}
                  </span>
                </div>
              </div>
              <button
                onClick={() => handleImport(
                  ev.eventId,
                  ev.name,
                  ev.date,
                  ev.classificationId,
                  ev.organiserName,
                  ev.organiserId,
                )}
                disabled={importMutation.isPending}
                className="px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap flex-shrink-0"
              >
                {importMutation.isPending && importingEventId === ev.eventId
                  ? t("importing", { ns: "common" })
                  : t("import", { ns: "common" })}
              </button>
            </div>
          </div>
        ))}
      </div>

      {importMutation.isError && (
        <div className="text-sm text-red-600 mt-2">
          {t("importFailed", { message: importMutation.error.message })}
        </div>
      )}
    </div>
  );
}

