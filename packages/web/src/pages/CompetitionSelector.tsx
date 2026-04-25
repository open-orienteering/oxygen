import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { formatDate } from "../lib/format";
import { LanguageSelector } from "../components/LanguageSelector";

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

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* Language Selector — top right */}
        <div className="flex justify-end mb-2">
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
            <ul className="divide-y divide-slate-100">
              {competitions.data.map((comp) => (
                <li key={comp.id}>
                  <div className="flex items-center hover:bg-blue-50 transition-colors group">
                    <Link
                      to={`/${comp.nameId}`}
                      className="flex-1 px-6 py-4 text-left flex items-center justify-between cursor-pointer"
                    >
                      <div>
                        <div className="font-semibold text-slate-900 group-hover:text-blue-700 transition-colors">
                          {comp.name}
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-sm text-slate-500">
                          <span className="inline-flex items-center gap-1">
                            <svg
                              className="w-4 h-4"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                              />
                            </svg>
                            {comp.date}
                          </span>
                          <span className="text-slate-400 font-mono text-xs">
                            {comp.nameId}
                          </span>
                          {comp.remoteHost && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 text-[10px] font-medium" title={t("remoteDatabase", { host: comp.remoteHost })}>
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
                              </svg>
                              {comp.remoteHost}
                            </span>
                          )}
                          {comp.annotation && (
                            <span className="text-slate-400">
                              {comp.annotation}
                            </span>
                          )}
                          {comp.eventorEnv === "test" && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-bold uppercase tracking-wider">
                              {t("testEventor")}
                            </span>
                          )}
                        </div>
                      </div>
                      <svg
                        className="w-5 h-5 text-slate-300 group-hover:text-blue-500 transition-colors flex-shrink-0"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 5l7 7-7 7"
                        />
                      </svg>
                    </Link>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteConfirm({ nameId: comp.nameId, name: comp.name });
                      }}
                      className="px-3 py-4 text-slate-300 hover:text-red-500 transition-colors cursor-pointer opacity-0 group-hover:opacity-100"
                      title={t("deleteCompetitionTitle")}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
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
            <div className="bg-white rounded-2xl shadow-xl border border-slate-200 p-6 max-w-sm w-full">
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
              <p className="text-xs text-slate-400 font-mono mb-5">
                {t("database", { ns: "common" })}: {deleteConfirm.nameId}
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
          <PurgeButton onPurged={() => competitions.refetch()} />
        </div>
      </div>
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
  const [dbName, setDbName] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Separate DB connection fields
  const [useRemoteDb, setUseRemoteDb] = useState(false);
  const [dbHost, setDbHost] = useState("");
  const [dbPort, setDbPort] = useState("3306");
  const [dbUser, setDbUser] = useState("");
  const [dbPassword, setDbPassword] = useState("");

  const createMutation = trpc.competition.create.useMutation({
    onSuccess: (data) => onCreated(data.nameId),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createMutation.mutate({
      name: name.trim(),
      date,
      dbName: dbName.trim() || undefined,
      ...(useRemoteDb && dbHost.trim()
        ? {
          dbConnection: {
            host: dbHost.trim(),
            port: parseInt(dbPort, 10) || 3306,
            user: dbUser.trim() || undefined,
            password: dbPassword || undefined,
          },
        }
        : {}),
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
        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-xs text-slate-400 hover:text-slate-600 cursor-pointer flex items-center gap-1"
          >
            <svg
              className={`w-3 h-3 transition-transform ${showAdvanced ? "rotate-90" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            {showAdvanced ? t("hideAdvanced") : t("showAdvanced")}
          </button>
          {showAdvanced && (
            <div className="mt-3 space-y-3 p-3 bg-slate-50 rounded-lg border border-slate-200">
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">
                  {t("databaseName")} <span className="text-slate-400 font-normal">({t("optional", { ns: "common" })})</span>
                </label>
                <input
                  type="text"
                  value={dbName}
                  onChange={(e) => setDbName(e.target.value)}
                  placeholder={t("databaseNamePlaceholder")}
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                />
              </div>

              {/* Remote DB toggle */}
              <div className="pt-1 border-t border-slate-200">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useRemoteDb}
                    onChange={(e) => setUseRemoteDb(e.target.checked)}
                    className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                  />
                  <span className="text-sm text-slate-600">{t("useSeparateDb")}</span>
                </label>
                <p className="text-xs text-slate-400 mt-1 ml-6">
                  {t("useSeparateDbDesc")}
                </p>
              </div>

              {useRemoteDb && (
                <div className="space-y-3 pl-6">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2">
                      <label className="block text-xs font-medium text-slate-500 mb-1">{t("host", { ns: "common" })}</label>
                      <input
                        type="text"
                        value={dbHost}
                        onChange={(e) => setDbHost(e.target.value)}
                        placeholder="e.g. 192.168.1.100"
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">{t("port", { ns: "common" })}</label>
                      <input
                        type="number"
                        value={dbPort}
                        onChange={(e) => setDbPort(e.target.value)}
                        placeholder="3306"
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white tabular-nums"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">
                        {t("username", { ns: "common" })} <span className="text-slate-400 font-normal">({t("optional", { ns: "common" })})</span>
                      </label>
                      <input
                        type="text"
                        value={dbUser}
                        onChange={(e) => setDbUser(e.target.value)}
                        placeholder="meos"
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">
                        {t("password", { ns: "common" })} <span className="text-slate-400 font-normal">({t("optional", { ns: "common" })})</span>
                      </label>
                      <input
                        type="password"
                        value={dbPassword}
                        onChange={(e) => setDbPassword(e.target.value)}
                        placeholder="••••••"
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-amber-600 flex items-center gap-1">
                    <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                    </svg>
                    {t("remoteMeosWarning")}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex gap-3 pt-1">
          <button
            type="submit"
            disabled={createMutation.isPending || !name.trim()}
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
    organiserName?: string,
    organiserId?: number,
  ) => {
    setImportingEventId(eventId);
    importMutation.mutate({
      eventId,
      eventName: name,
      eventDate: date,
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
                onClick={() => handleImport(ev.eventId, ev.name, ev.date, ev.organiserName, ev.organiserId)}
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

// ─── Purge Deleted Records Button ────────────────────────────

function PurgeButton({ onPurged }: { onPurged: () => void }) {
  const { t } = useTranslation("event");
  const [confirming, setConfirming] = useState(false);
  const purgeMutation = trpc.competition.purgeDeleted.useMutation({
    onSuccess: (data) => {
      onPurged();
      setTimeout(() => {
        setConfirming(false);
        purgeMutation.reset();
      }, 3000);
    },
  });

  if (purgeMutation.isSuccess && purgeMutation.data) {
    const { purged, droppedDatabases } = purgeMutation.data;
    if (purged === 0) {
      return (
        <span className="text-xs text-slate-400">
          {t("noDeletedRecords")}
        </span>
      );
    }
    return (
      <span className="text-xs text-emerald-600">
        {t("purgedRecords", { count: purged })}
        {droppedDatabases > 0 && t("droppedDatabases", { count: droppedDatabases })}
      </span>
    );
  }

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-2 text-xs">
        <span className="text-slate-500">{t("purgeConfirm")}</span>
        <button
          onClick={() => purgeMutation.mutate()}
          disabled={purgeMutation.isPending}
          className="text-red-500 hover:text-red-700 font-medium cursor-pointer"
        >
          {purgeMutation.isPending ? t("purging") : t("yesPurge")}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={purgeMutation.isPending}
          className="text-slate-400 hover:text-slate-600 cursor-pointer"
        >
          {t("cancel", { ns: "common" })}
        </button>
      </span>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="text-xs text-slate-400 hover:text-slate-600 cursor-pointer"
      title={t("cleanUpTitle")}
    >
      {t("cleanUpDeleted")}
    </button>
  );
}
