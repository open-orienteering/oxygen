import { useState } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@oxygen/api";

type RouterOutputs = inferRouterOutputs<AppRouter>;

/** Lantmäteriet's Geotorget, where the account is created and the product ordered (docs/map-terrain.md §7.0b 8). */
export const GEOTORGET_URL = "https://geotorget.lantmateriet.se/";

type View = RouterOutputs["demSettings"]["get"];
type MapRow = RouterOutputs["demSettings"]["maps"][number];
type Origin = View["status"]["providers"]["origin"];

const card = "bg-white rounded-2xl shadow-sm border border-slate-200 p-5";
const smallButton = "px-3 py-1.5 text-sm border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 cursor-pointer";

/**
 * Settings → Height data (docs/map-terrain.md §7.0b, §7.8): the
 * explanation, the providers, the Geotorget account (write-only: the
 * password field is never filled from the server, which never sends it),
 * the resolution, Test connection and each club map's DEM state. Rendered
 * as the admin tab `terrain` of the settings page; every procedure behind
 * it is `adminProcedure`.
 */
export function HeightDataPanel() {
  const { t } = useTranslation("heightData");
  const view = trpc.demSettings.get.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data?.liveCheck?.state === "running" ? 2000 : false),
  });
  return (
    <div data-testid="height-data-panel" className="space-y-4">
      <Explanation />
      {view.isLoading || !view.data ? (
        <p className="text-sm text-slate-400">{t("loading", { ns: "common" })}</p>
      ) : (
        <>
          <ProvidersCard view={view.data} />
          <AccountCard view={view.data} />
          <ResolutionCard view={view.data} />
          <TestConnectionCard view={view.data} />
          <MapsCard />
        </>
      )}
      {view.isError && <p className="text-sm text-red-600">{view.error.message}</p>}
    </div>
  );
}

function Explanation() {
  const { t } = useTranslation("heightData");
  return (
    <section data-testid="height-data-explanation" className={`${card} text-sm text-slate-700 space-y-3`}>
      <h2 className="text-sm font-semibold text-slate-800">{t("whatTitle")}</h2>
      <p>{t("whatIntro")}</p>
      <ul className="list-disc pl-5 space-y-1">
        <li>{t("whatGround")}</li>
        <li>{t("whatAnchor")}</li>
        <li>{t("whatTracks")}</li>
      </ul>
      <p>{t("whatOptIn")}</p>
      <dl className="grid gap-2 sm:grid-cols-2">
        <div>
          <dt className="font-medium">{t("lmName")}</dt>
          <dd className="text-slate-600">{t("lmDesc")}</dd>
        </div>
        <div>
          <dt className="font-medium">{t("gloName")}</dt>
          <dd className="text-slate-600">{t("gloDesc")}</dd>
        </div>
      </dl>
      <h3 className="font-medium text-slate-800">{t("accountHowTitle")}</h3>
      <ol className="list-decimal pl-5 space-y-1">
        <li>{t("accountHow1")}</li>
        <li>{t("accountHow2")}</li>
        <li>{t("accountHow3")}</li>
      </ol>
      <p>
        <a data-testid="height-data-geotorget-link" href={GEOTORGET_URL} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline">
          {t("geotorgetLink")}
        </a>
      </p>
      <p>{t("attribution")}</p>
      <p className="text-slate-600">{t("testHow")}</p>
    </section>
  );
}

function OriginBadge({ origin, testId }: { origin: Origin; testId: string }) {
  const { t } = useTranslation("heightData");
  return (
    <span data-testid={testId} className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
      {t(`origin_${origin}`)}
    </span>
  );
}

function useInvalidate() {
  const utils = trpc.useUtils();
  return () => {
    void utils.demSettings.get.invalidate();
    void utils.demSettings.maps.invalidate();
  };
}

/** A save whose answer is the new view: put it in the cache at once, then refresh the map list. */
function useSave() {
  const utils = trpc.useUtils();
  return trpc.demSettings.save.useMutation({
    onSuccess: (v) => {
      utils.demSettings.get.setData(undefined, v);
      void utils.demSettings.maps.invalidate();
    },
  });
}

function ProvidersCard({ view }: { view: View }) {
  const { t } = useTranslation("heightData");
  const save = useSave();
  // while a save is in flight the switches show what was asked for
  const pending = save.isPending ? save.variables?.providers : undefined;
  const p = pending ? { ...view.status.providers, ...pending } : view.status.providers;
  const set = (next: { lantmateriet: boolean; glo30: boolean }) => save.mutate({ providers: next });
  const warnings = view.status.warnings.filter((w) => w !== "lantmateriet-no-account");
  return (
    <section data-testid="height-data-providers" className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold text-slate-800">{t("providersTitle")}</h2>
        <OriginBadge origin={p.origin} testId="height-data-providers-origin" />
      </div>
      <div className="space-y-2">
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input type="checkbox" data-testid="height-data-provider-lantmateriet" checked={p.lantmateriet} disabled={save.isPending} onChange={(e) => set({ lantmateriet: e.target.checked, glo30: p.glo30 })} className="mt-0.5" />
          <span>
            <span className="font-medium">{t("lmName")}</span>
            {p.lantmateriet && !view.status.active.lantmateriet && (
              <span data-testid="height-data-lm-needs-account" className="block text-xs text-amber-700">
                {t("lmNeedsAccount")}
              </span>
            )}
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input type="checkbox" data-testid="height-data-provider-glo30" checked={p.glo30} disabled={save.isPending} onChange={(e) => set({ lantmateriet: p.lantmateriet, glo30: e.target.checked })} className="mt-0.5" />
          <span className="font-medium">{t("gloName")}</span>
        </label>
      </div>
      {p.origin === "saved" && (
        <button type="button" data-testid="height-data-providers-reset" className={`${smallButton} mt-3`} disabled={save.isPending} onClick={() => save.mutate({ providers: null })}>
          {t("resetToDeploy")}
        </button>
      )}
      {warnings.map((w) => (
        <p key={w} data-testid={`height-data-warning-${w}`} className="mt-2 text-xs text-amber-700">
          {t(`warning_${w}`)}
        </p>
      ))}
      {save.isError && <p className="mt-2 text-sm text-red-600">{save.error.message}</p>}
    </section>
  );
}

function AccountCard({ view }: { view: View }) {
  const { t, i18n } = useTranslation("heightData");
  const invalidate = useInvalidate();
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [requeued, setRequeued] = useState<number | null>(null);
  const setAccount = trpc.demSettings.setAccount.useMutation({
    onSuccess: (r) => {
      setUser("");
      setPassword("");
      setReplacing(false);
      setRequeued(r.requeued);
      invalidate();
    },
  });
  const clear = trpc.demSettings.clearAccount.useMutation({
    onSuccess: () => {
      setReplacing(false);
      setRequeued(null);
      invalidate();
    },
  });
  const account = view.status.account;
  const showForm = !account || account.origin === "environment" || replacing;
  const when = account?.savedAt ? new Date(account.savedAt).toLocaleString(i18n.language) : "";
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!user.trim() || !password) return;
    setAccount.mutate({ user: user.trim(), password });
  };

  return (
    <section data-testid="height-data-account" className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold text-slate-800">{t("accountTitle")}</h2>
        <span data-testid="height-data-account-status" className={`text-xs flex items-center gap-1 ${account ? "text-green-600 font-medium" : "text-slate-400"}`}>
          <span className={`w-2 h-2 rounded-full inline-block ${account ? "bg-green-500" : "bg-slate-300"}`} />
          {account?.origin === "saved" ? t("accountSaved", { user: account.user }) : account ? t("accountFromDeploy", { user: account.user }) : t("accountNone")}
        </span>
      </div>
      {account?.origin === "saved" && account.savedAt && (
        <p data-testid="height-data-account-saved-at" className="text-xs text-slate-500 mb-3">
          {account.savedBy ? t("accountSavedAt", { when, by: account.savedBy }) : t("accountSavedAtNoBy", { when })}
        </p>
      )}
      {view.status.accountUnreadable && <p data-testid="height-data-warning-account-unreadable" className="text-xs text-amber-700 mb-3">{t("warning_account-unreadable")}</p>}

      {showForm ? (
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" autoComplete="off">
          <label className="text-xs text-slate-600">
            {t("userLabel")}
            <input data-testid="height-data-account-user" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" spellCheck={false} className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </label>
          <label className="text-xs text-slate-600">
            {t("passwordLabel")}
            <input type="password" data-testid="height-data-account-password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </label>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <button type="submit" data-testid="height-data-account-save" disabled={setAccount.isPending || !user.trim() || !password} className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 cursor-pointer">
              {setAccount.isPending ? t("saving") : t("saveAccount")}
            </button>
            {replacing && (
              <button type="button" onClick={() => setReplacing(false)} className="px-4 py-2 text-sm text-slate-500 hover:text-slate-700 cursor-pointer">
                {t("cancel", { ns: "common" })}
              </button>
            )}
          </div>
          {setAccount.isError && <p className="text-sm text-red-600 sm:col-span-2">{setAccount.error.message}</p>}
        </form>
      ) : null}
      {account?.origin === "saved" && !replacing && (
        <div className="flex flex-wrap gap-2">
          <button type="button" data-testid="height-data-account-change" onClick={() => setReplacing(true)} className={smallButton}>
            {t("changeAccount")}
          </button>
          <button type="button" data-testid="height-data-account-clear" onClick={() => clear.mutate()} disabled={clear.isPending} className="px-3 py-1.5 text-sm text-red-600 border border-red-100 rounded-lg hover:bg-red-50 disabled:opacity-50 cursor-pointer">
            {t("clearAccount")}
          </button>
        </div>
      )}
      {requeued !== null && requeued > 0 && <p data-testid="height-data-account-requeued" className="mt-2 text-xs text-slate-600">{t("requeued", { count: requeued })}</p>}
      {clear.isError && <p className="mt-2 text-sm text-red-600">{clear.error.message}</p>}
    </section>
  );
}

function ResolutionCard({ view }: { view: View }) {
  const { t } = useTranslation("heightData");
  const save = useSave();
  const r = (save.isPending ? save.variables?.resolutionM : undefined) ?? view.status.resolutionM;
  return (
    <section data-testid="height-data-resolution" className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold text-slate-800">{t("resolutionTitle")}</h2>
        <OriginBadge origin={view.status.resolutionOrigin} testId="height-data-resolution-origin" />
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        {([2, 1] as const).map((m) => (
          <label key={m} className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="height-data-resolution" data-testid={`height-data-resolution-${m}`} checked={r === m} disabled={save.isPending} onChange={() => save.mutate({ resolutionM: m })} />
            {t(m === 2 ? "resolution2" : "resolution1")}
          </label>
        ))}
      </div>
      {view.status.resolutionOrigin === "saved" && (
        <button type="button" data-testid="height-data-resolution-reset" className={`${smallButton} mt-3`} disabled={save.isPending} onClick={() => save.mutate({ resolutionM: null })}>
          {t("resetToDeploy")}
        </button>
      )}
      {save.isError && <p className="mt-2 text-sm text-red-600">{save.error.message}</p>}
    </section>
  );
}

function TestConnectionCard({ view }: { view: View }) {
  const { t, i18n } = useTranslation("heightData");
  const utils = trpc.useUtils();
  const maps = trpc.demSettings.maps.useQuery();
  const [picked, setPicked] = useState("");
  const run = trpc.demSettings.testConnection.useMutation({ onSuccess: () => void utils.demSettings.get.invalidate() });
  const eligible = (maps.data ?? []).filter((m) => m.liveCheck === null);
  const live = view.liveCheck;
  const hasAccount = view.status.account !== null;
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language) : "");
  const pct = (v: number) => (v * 100).toFixed(1);

  return (
    <section data-testid="height-data-test" className={card}>
      <h2 className="text-sm font-semibold text-slate-800 mb-3">{t("testTitle")}</h2>
      {!hasAccount ? (
        <p className="text-xs text-slate-500">{t("testNeedsAccount")}</p>
      ) : eligible.length === 0 ? (
        <p className="text-xs text-slate-500">{t("testNoMaps")}</p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-600">
            {t("testMap")}
            <select data-testid="height-data-test-map" value={picked} onChange={(e) => setPicked(e.target.value)} className="mt-1 block px-3 py-2 border border-slate-200 rounded-lg text-sm">
              <option value="">{t("testPick")}</option>
              {eligible.map((m) => (
                <option key={m.clubMapId} value={m.clubMapId}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" data-testid="height-data-test-run" disabled={!picked || run.isPending || live?.state === "running"} onClick={() => run.mutate({ clubMapId: picked })} className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 cursor-pointer">
            {t("testRun")}
          </button>
        </div>
      )}
      {run.isError && <p className="mt-2 text-sm text-red-600">{run.error.message}</p>}
      {live && (
        <div data-testid="height-data-test-result" data-state={live.state} className="mt-3 text-sm">
          {live.state === "running" ? (
            <p className="text-slate-600">{t("testRunning", { when: fmt(live.startedAt) })}</p>
          ) : live.state === "error" ? (
            <p className="text-red-600">{t("testError", { map: live.mapName, error: live.error ?? "" })}</p>
          ) : live.report ? (
            <>
              <p className={live.report.verdict.pass ? "text-green-700 font-medium" : "text-red-600 font-medium"}>
                {t(live.report.verdict.pass ? "testPass" : "testFail", { map: live.mapName, when: fmt(live.finishedAt) })}
              </p>
              <ul className="mt-2 space-y-0.5 text-xs">
                {(["rangeServed", "credentialContained", "profileRead", "has2m", "spreadHolds"] as const).map((k) => (
                  <li key={k} data-testid={`height-data-check-${k}`} className={live.report!.verdict[k] ? "text-green-700" : "text-red-600"}>
                    {live.report!.verdict[k] ? "✓" : "✗"} {t(`check_${k}`)}
                  </li>
                ))}
              </ul>
              {"at1m" in live.report.spread && (
                <p className="mt-1 text-xs text-slate-500">{t("testAccepted", { at1m: pct(live.report.spread.at1m.acceptedOfCovered), at2m: pct(live.report.spread.at2m.acceptedOfCovered) })}</p>
              )}
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}

function stateLabel(row: MapRow): `state_${MapRow["state"] | "notFetched"}` {
  if (row.state === "pending" && !row.job) return "state_notFetched";
  return `state_${row.state}`;
}

function MapsCard() {
  const { t, i18n } = useTranslation("heightData");
  const utils = trpc.useUtils();
  const maps = trpc.demSettings.maps.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data?.some((m) => m.state === "pending" && m.job !== null) ? 3000 : false),
  });
  const retry = trpc.demSettings.retry.useMutation({ onSettled: () => void utils.demSettings.maps.invalidate() });
  const rows = maps.data ?? [];
  return (
    <section data-testid="height-data-maps" className={card}>
      <h2 className="text-sm font-semibold text-slate-800 mb-3">{t("mapsTitle")}</h2>
      {maps.isLoading ? (
        <p className="text-sm text-slate-400">{t("loading", { ns: "common" })}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500">{t("mapsEmpty")}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th className="py-1 pr-2 font-medium">{t("colMap")}</th>
              <th className="py-1 pr-2 font-medium">{t("colState")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.clubMapId} data-testid={`height-data-map-${row.clubMapId}`} data-state={row.state} className="border-t border-slate-100 align-top">
                <td className="py-2 pr-2">{row.name}</td>
                <td className="py-2 pr-2">
                  <span data-testid="height-data-map-state">{t(stateLabel(row))}</span>
                  {row.reason && <span className="text-slate-500"> — {t(`reason_${row.reason}`, { defaultValue: row.reason })}</span>}
                  {row.providerId && row.state !== "disabled" && <span className="block text-xs text-slate-400">{row.providerId}</span>}
                  {row.job && row.state === "failed" && (
                    <span className="block text-xs text-slate-400">
                      {t("attempts", { count: row.job.attempts })}
                      {row.job.nextAttemptAt ? ` · ${t("nextAttempt", { when: new Date(row.job.nextAttemptAt).toLocaleString(i18n.language) })}` : ""}
                    </span>
                  )}
                </td>
                <td className="py-2 text-right">
                  {row.retryable && (
                    <button type="button" data-testid="height-data-map-retry" disabled={retry.isPending} onClick={() => retry.mutate({ clubMapId: row.clubMapId })} className={smallButton}>
                      {t(row.job ? "retry" : "fetchNow")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {retry.isError && <p className="mt-2 text-sm text-red-600">{retry.error.message}</p>}
    </section>
  );
}
