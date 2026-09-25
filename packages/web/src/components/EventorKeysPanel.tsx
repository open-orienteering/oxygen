import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { EventorEnvironment } from "@oxygen/shared";
import { trpc } from "../lib/trpc";

const ENVIRONMENTS: EventorEnvironment[] = ["prod", "test"];

/**
 * Club-wide Eventor API keys, one per environment. Rendered as the Eventor
 * tab of the settings page, which owns the page chrome and the admin gate;
 * the mutations behind it are `adminProcedure` as well, so a non-admin who
 * deep-links here gets a FORBIDDEN error rather than a silent no-op.
 */
export function EventorKeysPanel() {
  const { t } = useTranslation("event");
  return (
    <div data-testid="eventor-keys-panel" className="space-y-4">
      <p className="text-sm text-slate-600">{t("eventorKeysHelp")}</p>
      {ENVIRONMENTS.map((env) => (
        <EventorKeyCard key={env} env={env} />
      ))}
    </div>
  );
}

function EventorKeyCard({ env }: { env: EventorEnvironment }) {
  const { t } = useTranslation("event");
  const utils = trpc.useUtils();
  const [apiKey, setApiKey] = useState("");
  const [replacing, setReplacing] = useState(false);

  const status = trpc.eventor.keyStatus.useQuery({ env });
  const invalidate = () => {
    void utils.eventor.keyStatus.invalidate({ env });
    // Panels elsewhere (Event page sync, trends) key off syncStatus too.
    void utils.eventor.syncStatus.invalidate();
  };
  const validate = trpc.eventor.validateKey.useMutation({
    onSuccess: () => {
      setApiKey("");
      setReplacing(false);
      invalidate();
    },
  });
  const clear = trpc.eventor.clearKey.useMutation({
    onSuccess: () => {
      setReplacing(false);
      invalidate();
    },
  });

  const connected = status.data?.connected === true;
  const orgName = status.data?.connected ? status.data.organisationName ?? "" : "";
  const showForm = !connected || replacing;
  const isTest = env === "test";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) return;
    validate.mutate({ apiKey: apiKey.trim(), env });
  };

  return (
    <div
      data-testid={`eventor-key-card-${env}`}
      className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
          {isTest ? (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-bold uppercase tracking-wider">
              {t("testEventor")}
            </span>
          ) : (
            t("production")
          )}
        </h2>
        {status.isLoading ? (
          <span className="text-xs text-slate-400">{t("loading", { ns: "common" })}</span>
        ) : connected ? (
          <span
            data-testid={`eventor-key-status-${env}`}
            className="text-xs text-green-600 font-medium flex items-center gap-1"
          >
            <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
            {orgName ? t("connectedTo", { name: orgName }) : t("eventorKeyConfigured")}
          </span>
        ) : (
          <span
            data-testid={`eventor-key-status-${env}`}
            className="text-xs text-slate-400 flex items-center gap-1"
          >
            <span className="w-2 h-2 rounded-full bg-slate-300 inline-block" />
            {t("eventorKeyNotConfigured")}
          </span>
        )}
      </div>

      {showForm ? (
        <form onSubmit={submit} className="space-y-3">
          <p className="text-xs text-slate-500">{t("apiKeyPrompt")}</p>
          <input
            type="text"
            data-testid={`eventor-key-input-${env}`}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t("apiKeyPlaceholder")}
            autoComplete="off"
            className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              data-testid={`eventor-key-connect-${env}`}
              disabled={validate.isPending || !apiKey.trim()}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors cursor-pointer"
            >
              {validate.isPending ? t("validating") : t("connect")}
            </button>
            {replacing && (
              <button
                type="button"
                onClick={() => {
                  setReplacing(false);
                  setApiKey("");
                }}
                className="px-4 py-2 text-sm text-slate-500 hover:text-slate-700 cursor-pointer"
              >
                {t("cancel", { ns: "common" })}
              </button>
            )}
          </div>
          {validate.isError && (
            <p className="text-sm text-red-600">{validate.error.message}</p>
          )}
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid={`eventor-key-change-${env}`}
            onClick={() => setReplacing(true)}
            className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
          >
            {t("changeKey")}
          </button>
          <button
            type="button"
            data-testid={`eventor-key-clear-${env}`}
            onClick={() => clear.mutate({ env })}
            disabled={clear.isPending}
            className="px-3 py-1.5 text-sm text-red-600 border border-red-100 rounded-lg hover:bg-red-50 disabled:opacity-50 cursor-pointer"
          >
            {clear.isPending ? t("eventorKeyClearing") : t("eventorKeyClear")}
          </button>
        </div>
      )}
      {clear.isError && (
        <p className="mt-2 text-sm text-red-600">{clear.error.message}</p>
      )}
    </div>
  );
}
