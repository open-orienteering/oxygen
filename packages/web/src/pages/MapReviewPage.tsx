/**
 * Import review of a stored map document (docs/map-symbols.md §8.7;
 * research 06 §5.1): one row per source symbol, most used first, the
 * file's own swatch beside the library's top-3 candidates; decisions are
 * collected per row and sent as one `mapImport.decide`, whose job imports
 * the source again; `finalise` then pins the reviewed document on the club
 * map's version or the event's map. Mounted twice: from the club library
 * (`/settings/map-review/:documentHash?clubMap=<series>`) and from an
 * event's course editor (`/:nameId/map-review/:documentHash`).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { inferRouterOutputs } from "@trpc/server";
import type { TFunction } from "i18next";
import type { AppRouter } from "@oxygen/api";
import { symbolLibrary } from "@oxygen/shared";
import { trpc } from "../lib/trpc";
import { useCurrentUser } from "../context/CurrentUserContext";
import { useCapabilities } from "../context/CapabilitiesContext";
import { LanguageSelector } from "../components/LanguageSelector";
import { UserChip } from "../components/UserChip";
import {
  candidateIsCurrent,
  isJobPending,
  jobProgressPercent,
  orderReviewRows,
  pendingToDecisions,
  rowOutcome,
  scopePreviewUrl,
  setPending,
  summariseOutcomes,
  type PendingDecision,
  type PendingDecisions,
  type ReviewOutcome,
} from "../lib/map-review";

type Outputs = inferRouterOutputs<AppRouter>["mapImport"];
type ReviewData = Outputs["review"];
type ReviewRowData = ReviewData["symbols"][number];
/** The fields of a job (`mapImport.status`) the page follows; its `report` (JsonValue) trips TS2589 when inferred. */
interface Job {
  id: string;
  state: string;
  documentHash: string | null;
  error: string | null;
}
type CrtImport = Outputs["importCrt"];

/** 1 MiB, the API's `importCrt` limit (docs/map-symbols.md §8.6). */
const MAX_CRT_BYTES = 1024 * 1024;

const OUTCOME_STYLE: Record<ReviewOutcome, string> = {
  suggested: "bg-amber-100 text-amber-800",
  accepted: "bg-emerald-100 text-emerald-800",
  kept: "bg-slate-200 text-slate-700",
  auto: "bg-blue-100 text-blue-800",
  unmatched: "bg-slate-100 text-slate-600",
  variant: "bg-slate-100 text-slate-600",
  none: "bg-slate-100 text-slate-600",
};

const SUMMARY_ORDER: ReviewOutcome[] = ["suggested", "accepted", "kept", "auto", "unmatched", "variant", "none"];

type Target = { kind: "club"; clubMapId: string | null } | { kind: "event"; nameId: string };

interface ReviewProps {
  documentHash: string;
  target: Target;
  /** The document the target uses now; `undefined` while unknown. */
  pinnedHash: string | null | undefined;
  mapName: string | null;
  canEdit: boolean;
  backTo: string;
  pathFor: (hash: string) => string;
  onFinalised: () => void;
}

/** Club library entry point: Settings → Maps → card → Review symbols. */
export function ClubMapReviewPage() {
  const { documentHash = "" } = useParams<{ documentHash: string }>();
  const [searchParams] = useSearchParams();
  const clubMapId = searchParams.get("clubMap");
  const { user, authEnabled } = useCurrentUser();
  const utils = trpc.useUtils();
  const maps = trpc.clubMap.list.useQuery();
  const row = clubMapId ? maps.data?.find((m) => m.id === clubMapId) : undefined;
  const pinnedHash = !clubMapId ? null : maps.data ? (row?.version?.documentHash ?? null) : undefined;
  return (
    <ReviewFrame>
      <MapReview
        key={documentHash}
        documentHash={documentHash}
        target={{ kind: "club", clubMapId }}
        pinnedHash={pinnedHash}
        mapName={row?.name ?? null}
        // Club library mutations: any signed-in user (club-library.md).
        canEdit={!authEnabled || user !== null}
        backTo="/settings"
        pathFor={(hash) => `/settings/map-review/${hash}${clubMapId ? `?clubMap=${clubMapId}` : ""}`}
        onFinalised={() => void utils.clubMap.list.invalidate()}
      />
    </ReviewFrame>
  );
}

/** Event entry point: the course editor's map info row (review is optional for event maps). */
export function EventMapReviewPage() {
  const { nameId = "", documentHash = "" } = useParams<{ nameId: string; documentHash: string }>();
  const { has } = useCapabilities();
  const utils = trpc.useUtils();
  const metadata = trpc.course.mapMetadata.useQuery();
  const fileInfo = trpc.course.mapFileInfo.useQuery();
  return (
    <div className="p-4">
      <MapReview
        key={documentHash}
        documentHash={documentHash}
        target={{ kind: "event", nameId }}
        pinnedHash={metadata.data === undefined ? undefined : (metadata.data?.documentHash ?? null)}
        mapName={fileInfo.data?.fileName ?? null}
        canEdit={has("courses.edit")}
        backTo={`/${nameId}/course-editor`}
        pathFor={(hash) => `/${nameId}/map-review/${hash}`}
        onFinalised={() => {
          void utils.course.mapMetadata.invalidate();
          void utils.course.mapFileInfo.invalidate();
        }}
      />
    </div>
  );
}

function ReviewFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4">
      <div className="max-w-5xl mx-auto">
        <div className="flex justify-end mb-2 items-center gap-3">
          <UserChip />
          <LanguageSelector />
        </div>
        {children}
      </div>
    </div>
  );
}

function useEntryName() {
  const { i18n } = useTranslation();
  return (canonicalId: string): string => {
    const entry = symbolLibrary.getLibraryEntry(canonicalId);
    if (!entry) return canonicalId;
    const name = (entry.name as { en: string; sv?: string })[i18n.language === "sv" ? "sv" : "en"] ?? entry.name.en;
    return `${entry.code} ${name}`;
  };
}

function MapReview({ documentHash, target, pinnedHash, mapName, canEdit, backTo, pathFor, onFinalised }: ReviewProps) {
  const { t } = useTranslation("mapReview");
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const nameId = target.kind === "event" ? target.nameId : null;
  const review = trpc.mapImport.review.useQuery({ documentHash }, { retry: false });
  const [pending, setPendingMap] = useState<PendingDecisions>(new Map());
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyToReview, setOnlyToReview] = useState(false);
  const [showUnused, setShowUnused] = useState(false);
  const [finalisedNow, setFinalisedNow] = useState(false);

  const job = trpc.mapImport.status.useQuery(
    { jobId: jobId ?? "" },
    // Polled while held; `followJob` drops the id once the job is terminal.
    { enabled: jobId !== null, refetchInterval: jobId !== null ? 1000 : false },
  );

  /** A decide / importCrt job: follow it to the new document (map-storage.md §6.2 hold, else poll). */
  const followJob = (j: Job) => {
    if (j.state === "done" && j.documentHash) {
      setJobId(null);
      setPendingMap(new Map());
      if (j.documentHash === documentHash) void utils.mapImport.review.invalidate({ documentHash });
      else navigate(pathFor(j.documentHash));
    } else if (j.state === "failed") {
      setJobId(null);
      setError(t("jobFailed", { message: j.error ?? "" }));
    } else {
      setJobId(j.id);
    }
  };
  const followed = useRef<string | null>(null);
  useEffect(() => {
    const j = job.data;
    if (!j || isJobPending(j.state) || followed.current === `${j.id}:${j.state}`) return;
    followed.current = `${j.id}:${j.state}`;
    followJob(j);
  });

  const decide = trpc.mapImport.decide.useMutation();
  const applyPending = async () => {
    setError(null);
    try {
      const { job: decided } = await decide.mutateAsync({ documentHash, decisions: pendingToDecisions(pending) });
      followJob(decided as Job);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const finalise = trpc.mapImport.finalise.useMutation({
    onSuccess: () => {
      setFinalisedNow(true);
      onFinalised();
    },
    onError: (err) => setError(err.message),
  });

  const ordered = useMemo(() => orderReviewRows(review.data?.symbols ?? []), [review.data]);
  const counts = useMemo(() => summariseOutcomes(review.data?.symbols ?? []), [review.data]);
  const visible = (rows: ReviewRowData[]) =>
    onlyToReview ? rows.filter((r) => rowOutcome(r.match) === "suggested" || pending.has(r.symbolIdx)) : rows;

  const busy = decide.isPending || jobId !== null;
  const decideOn = (row: ReviewRowData, decision: PendingDecision | null) => setPendingMap((p) => setPending(p, row, decision));

  const header = (
    <div className="mb-4">
      <h1 className="text-2xl font-bold text-slate-900">{t("title")}</h1>
      {mapName && <div className="text-sm text-slate-600">{mapName}</div>}
      <Link to={backTo} data-testid="review-back" className="text-sm text-blue-600 hover:text-blue-800">
        {t("back")}
      </Link>
    </div>
  );

  if (review.isLoading) {
    return (
      <div data-testid="map-review-page">
        {header}
        <p className="text-sm text-slate-500">{t("loading")}</p>
      </div>
    );
  }
  if (review.error || !review.data) {
    const code = review.error?.data?.code;
    const message =
      code === "NOT_FOUND" || code === "BAD_REQUEST"
        ? t("notFound")
        : code === "UNAUTHORIZED" || code === "FORBIDDEN"
          ? t("accessDenied")
          : t("loadFailed", { message: review.error?.message ?? "" });
    return (
      <div data-testid="map-review-page">
        {header}
        <p data-testid={code === "UNAUTHORIZED" || code === "FORBIDDEN" ? "review-access-denied" : "review-not-found"} className="text-sm text-red-700">
          {message}
        </p>
      </div>
    );
  }

  const data = review.data;
  const inUse = pinnedHash === documentHash;
  const canFinalise = canEdit && pinnedHash !== undefined && !inUse && (target.kind === "event" || target.clubMapId !== null);
  const usedRows = visible(ordered.used);
  const unusedRows = visible(ordered.unused);
  const library = data.library;

  return (
    <div data-testid="map-review-page" data-document-hash={documentHash} className="pb-24">
      {header}

      <section className="bg-white rounded-xl border border-slate-200 p-4 mb-4 space-y-2 text-sm">
        <div className="text-slate-600">
          {t("library")}:{" "}
          <span className="font-medium text-slate-800">{library ? `${library.id} · ${library.version}` : "—"}</span>
        </div>
        {!library && <p className="text-amber-700">{t("noLibrary")}</p>}
        {inUse ? (
          <p data-testid="review-in-use" className="text-emerald-700">
            {finalisedNow ? t("finalised") : t("inUse")}
          </p>
        ) : pinnedHash !== undefined ? (
          <div data-testid="review-not-in-use" className="flex flex-wrap items-center gap-3 text-amber-800">
            <span>{t("notInUse")}</span>
            {canFinalise && (
              <button
                type="button"
                data-testid="review-finalise"
                disabled={finalise.isPending || busy}
                className="px-3 py-1 text-sm bg-blue-600 text-white rounded-lg cursor-pointer disabled:opacity-50"
                onClick={() => {
                  setError(null);
                  finalise.mutate({
                    documentHash,
                    target: target.kind === "event" ? { kind: "event" } : { kind: "club", clubMapId: target.clubMapId! },
                  });
                }}
              >
                {finalise.isPending ? t("finalising") : t("finalise")}
              </button>
            )}
            {canFinalise && (
              <span className="text-xs text-slate-500">{target.kind === "club" ? t("finaliseClub") : t("finaliseEvent")}</span>
            )}
          </div>
        ) : null}
        {!data.current && (
          <p data-testid="review-outdated" className="text-slate-600">
            {t("outdated")}
          </p>
        )}
        {!canEdit && <p className="text-slate-500">{t("readOnly")}</p>}
        <div className="flex flex-wrap gap-2 pt-1">
          {SUMMARY_ORDER.filter((o) => counts[o] > 0 || o === "suggested").map((o) => (
            <span
              key={o}
              data-testid={`review-summary-${o}`}
              data-count={counts[o]}
              className={`px-2 py-0.5 rounded-full text-xs font-medium ${OUTCOME_STYLE[o]}`}
            >
              {t(`summary.${o}`)}: {counts[o]}
            </span>
          ))}
        </div>
      </section>

      {error && (
        <p data-testid="review-error" className="mb-4 text-sm text-red-700">
          {error}
        </p>
      )}

      {jobId !== null && (
        <div data-testid="review-job-progress" className="mb-4 bg-white rounded-xl border border-blue-200 p-3 text-sm">
          <div>
            {t("jobProgress", { percent: jobProgressPercent(job.data?.progress ?? 0) })}
            {job.data?.stage && <span className="text-slate-500"> ({stageLabel(t, job.data.stage)})</span>}
          </div>
          <div className="mt-2 h-1.5 bg-slate-100 rounded">
            <div className="h-1.5 bg-blue-500 rounded" style={{ width: `${jobProgressPercent(job.data?.progress ?? 0)}%` }} />
          </div>
        </div>
      )}

      <CrtPanel documentHash={documentHash} canEdit={canEdit && !busy} onJob={followJob} onError={setError} rows={data.symbols} />

      <div className="flex items-center justify-between mt-6 mb-2">
        <h2 className="font-semibold text-slate-900">{t("usedSymbols")}</h2>
        <label className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer">
          <input
            type="checkbox"
            data-testid="review-filter-suggested"
            className="rounded border-slate-300"
            checked={onlyToReview}
            onChange={(e) => setOnlyToReview(e.target.checked)}
          />
          {t("onlyToReview")}
        </label>
      </div>

      <ul data-testid="review-rows" className="space-y-2">
        {usedRows.map((row) => (
          <ReviewRowCard key={row.symbolIdx} row={row} nameId={nameId} libraryId={library?.id ?? null} pending={pending.get(row.symbolIdx)} canEdit={canEdit && !busy} onDecide={decideOn} />
        ))}
        {usedRows.length === 0 && <li className="text-sm text-slate-500 py-4 text-center">{t("noRows")}</li>}
      </ul>

      {unusedRows.length > 0 && (
        <div className="mt-4">
          <button
            type="button"
            data-testid="review-unused-toggle"
            data-count={unusedRows.length}
            aria-expanded={showUnused}
            className="text-sm text-slate-600 hover:text-slate-900 cursor-pointer"
            onClick={() => setShowUnused((v) => !v)}
          >
            {showUnused ? "▾" : "▸"} {t("unusedSymbols", { count: unusedRows.length })}
          </button>
          {showUnused && (
            <ul data-testid="review-unused-rows" className="space-y-2 mt-2">
              {unusedRows.map((row) => (
                <ReviewRowCard key={row.symbolIdx} row={row} nameId={nameId} libraryId={library?.id ?? null} pending={pending.get(row.symbolIdx)} canEdit={canEdit && !busy} onDecide={decideOn} />
              ))}
            </ul>
          )}
        </div>
      )}

      {pending.size > 0 && (
        <div data-testid="review-pending-bar" className="fixed bottom-0 inset-x-0 z-40 bg-white border-t border-slate-200 shadow-lg p-3">
          <div className="max-w-5xl mx-auto flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium text-slate-800">{t("pendingCount", { count: pending.size })}</span>
            <span className="text-xs text-slate-500 flex-1 min-w-[12rem]">{t("clubWide")}</span>
            <button
              type="button"
              data-testid="review-discard"
              disabled={busy}
              className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg cursor-pointer disabled:opacity-50"
              onClick={() => setPendingMap(new Map())}
            >
              {t("discard")}
            </button>
            <button
              type="button"
              data-testid="review-apply"
              disabled={busy}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg cursor-pointer disabled:opacity-50"
              onClick={() => void applyPending()}
            >
              {busy ? t("applying") : t("apply", { count: pending.size })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function stageLabel(t: TFunction<"mapReview">, stage: string): string {
  switch (stage) {
    case "parse":
    case "normalise":
    case "match":
    case "encode":
    case "store":
    case "derive":
    case "done":
      return t(`stage.${stage}`);
    default:
      return stage;
  }
}

function Swatch({ src, testId, alt }: { src: string | null; testId: string; alt: string }) {
  if (!src) return <div className="h-16 w-16 flex-none rounded border border-dashed border-slate-200" />;
  return (
    <img
      src={src}
      alt={alt}
      data-testid={testId}
      loading="lazy"
      className="h-16 w-16 flex-none rounded border border-slate-200 bg-white object-contain"
    />
  );
}

function ReviewRowCard({
  row,
  nameId,
  libraryId,
  pending,
  canEdit,
  onDecide,
}: {
  row: ReviewRowData;
  nameId: string | null;
  libraryId: string | null;
  pending: PendingDecision | undefined;
  canEdit: boolean;
  onDecide: (row: ReviewRowData, decision: PendingDecision | null) => void;
}) {
  const { t } = useTranslation("mapReview");
  const entryName = useEntryName();
  const [pickingOther, setPickingOther] = useState(false);
  const outcome = rowOutcome(row.match);
  const decided = outcome === "accepted" || outcome === "kept";
  const pendingKind = pending ? ("accept" in pending ? "accept" : "unmatch" in pending ? "unmatch" : "reset") : undefined;
  const otherEntries = useMemo(
    () => (pickingOther && libraryId && symbolLibrary.isSymbolLibraryId(libraryId) ? symbolLibrary.getSymbolLibrary(libraryId).entries : []),
    [pickingOther, libraryId],
  );

  return (
    <li
      data-review-row=""
      data-testid={`review-row-${row.code}`}
      data-outcome={outcome}
      data-objects={row.objects}
      data-pending={pendingKind}
      className={`bg-white rounded-xl border p-3 ${pending ? "border-blue-400" : "border-slate-200"}`}
    >
      <div className="flex flex-wrap gap-4">
        <div className="flex gap-3 min-w-[16rem] flex-1">
          <div className="text-center">
            <Swatch src={scopePreviewUrl(row.previewUrl, nameId)} testId="review-source-swatch" alt={t("sourceSwatch")} />
            <div className="text-[10px] text-slate-400 mt-0.5">{t("sourceSwatch")}</div>
          </div>
          <div className="min-w-0 text-sm">
            <div className="font-semibold text-slate-900">
              {row.code} {row.name}
            </div>
            <div className="text-xs text-slate-500 flex flex-wrap gap-x-2">
              <span>{t(`type.${row.type}`)}</span>
              <span>{t("objects", { count: row.objects })}</span>
              <span>
                {t("colourClass")}: {row.colourClass}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${OUTCOME_STYLE[outcome]}`}>{t(`summary.${outcome}`)}</span>
              {row.flags
                .filter((f) => f !== "unused")
                .map((f) => (
                  <span key={f} className="px-1.5 py-0.5 rounded text-xs bg-slate-100 text-slate-600">
                    {t(`flag.${f}`)}
                  </span>
                ))}
            </div>
            <div className="mt-1 text-xs text-slate-600">
              {t("drawnAs")}: {row.match?.canonicalId ? entryName(row.match.canonicalId) : t("drawnAsSource")}
            </div>
          </div>
        </div>

        <div className="flex-[2] min-w-[18rem]">
          <div className="text-xs text-slate-500 mb-1">{t("candidates")}</div>
          {row.candidates.length === 0 ? (
            <p className="text-xs text-slate-400">{t("noCandidates")}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {row.candidates.map((c) => {
                const current = candidateIsCurrent(row, c.canonicalId);
                const chosen = pending && "accept" in pending && pending.accept === c.canonicalId;
                return (
                  <div
                    key={c.canonicalId}
                    data-candidate={c.canonicalId}
                    data-current={current ? "true" : "false"}
                    className={`w-40 rounded-lg border p-2 text-xs ${chosen ? "border-blue-500 bg-blue-50" : current ? "border-emerald-400" : "border-slate-200"}`}
                  >
                    <div className="flex gap-2">
                      <Swatch src={c.previewUrl} testId="review-candidate-swatch" alt={c.canonicalId} />
                      <div className="min-w-0">
                        <div className="font-medium text-slate-800 break-words">{entryName(c.canonicalId)}</div>
                        <div className="text-slate-500">{t("confidence", { percent: Math.round(c.confidence * 100) })}</div>
                        {current && <div className="text-emerald-700">{t("current")}</div>}
                      </div>
                    </div>
                    {c.reasons.length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-slate-500">{t("why")}</summary>
                        <ul className="mt-1 space-y-0.5 text-[11px] text-slate-600">
                          {c.reasons.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        data-testid="review-accept"
                        className="mt-1 w-full px-2 py-0.5 border border-slate-200 rounded cursor-pointer hover:bg-slate-50"
                        onClick={() => onDecide(row, { accept: c.canonicalId })}
                      >
                        {t("accept")}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {canEdit && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <button
                type="button"
                data-testid="review-keep"
                className="px-2 py-1 border border-slate-200 rounded cursor-pointer hover:bg-slate-50"
                onClick={() => onDecide(row, { unmatch: true })}
              >
                {t("keep")}
              </button>
              {decided && (
                <button
                  type="button"
                  data-testid="review-reset"
                  className="px-2 py-1 border border-slate-200 rounded cursor-pointer hover:bg-slate-50"
                  onClick={() => onDecide(row, { reset: true })}
                >
                  {t("reset")}
                </button>
              )}
              {libraryId &&
                (pickingOther ? (
                  <select
                    data-testid="review-other"
                    autoFocus
                    className="border border-slate-200 rounded px-1 py-1 bg-white max-w-[16rem]"
                    defaultValue=""
                    onChange={(e) => {
                      if (e.target.value) onDecide(row, { accept: e.target.value });
                      setPickingOther(false);
                    }}
                    onBlur={() => setPickingOther(false)}
                  >
                    <option value="">{t("otherPlaceholder")}</option>
                    {otherEntries.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entryName(entry.id)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <button
                    type="button"
                    data-testid="review-other-open"
                    className="px-2 py-1 text-blue-700 cursor-pointer hover:underline"
                    onClick={() => setPickingOther(true)}
                  >
                    {t("other")}
                  </button>
                ))}
            </div>
          )}

          {pending && (
            <div data-testid="review-pending" className="mt-2 flex items-center gap-2 text-xs text-blue-800">
              <span>
                {"accept" in pending
                  ? t("pendingAccept", { name: entryName(pending.accept) })
                  : "unmatch" in pending
                    ? t("pendingKeep")
                    : t("pendingReset")}
              </span>
              <button type="button" data-testid="review-undo" className="underline cursor-pointer" onClick={() => onDecide(row, null)}>
                {t("undo")}
              </button>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function CrtPanel({
  documentHash,
  canEdit,
  rows,
  onJob,
  onError,
}: {
  documentHash: string;
  canEdit: boolean;
  rows: ReviewRowData[];
  onJob: (job: Job) => void;
  onError: (message: string | null) => void;
}) {
  const { t } = useTranslation("mapReview");
  const entryName = useEntryName();
  const utils = trpc.useUtils();
  const [includeMatches, setIncludeMatches] = useState(false);
  const [exported, setExported] = useState<{ rules: number; kept: number; auto: number } | null>(null);
  const [preview, setPreview] = useState<{ fileName: string; crt: string; result: CrtImport } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const importCrt = trpc.mapImport.importCrt.useMutation();
  const codeOf = (symbolIdx: number) => rows.find((r) => r.symbolIdx === symbolIdx)?.code ?? `#${symbolIdx}`;

  const download = async () => {
    onError(null);
    try {
      const out = await utils.mapImport.exportCrt.fetch({ documentHash, includeMatches });
      const href = URL.createObjectURL(new Blob([out.crt], { type: "text/plain;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = href;
      a.download = out.fileName;
      a.click();
      URL.revokeObjectURL(href);
      setExported({ rules: out.rules, kept: out.kept, auto: out.auto });
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const choose = async (file: File) => {
    onError(null);
    setNote(null);
    if (file.size > MAX_CRT_BYTES) {
      onError(t("crt.tooLarge"));
      return;
    }
    try {
      const crt = await file.text();
      const result = await importCrt.mutateAsync({ documentHash, crt, dryRun: true });
      setPreview({ fileName: file.name, crt, result });
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const confirm = async () => {
    if (!preview) return;
    try {
      const result = await importCrt.mutateAsync({ documentHash, crt: preview.crt });
      setPreview(null);
      if (result.job) onJob(result.job as Job);
      else setNote(t("crt.nothingApplied"));
    } catch (err) {
      setPreview(null);
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section data-testid="review-crt" className="bg-white rounded-xl border border-slate-200 p-4 text-sm">
      <div className="font-semibold text-slate-900">{t("crt.title")}</div>
      <p className="text-xs text-slate-500 mb-2">{t("crt.hint")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" data-testid="review-crt-export" className="px-3 py-1 text-xs border border-slate-200 rounded-lg cursor-pointer hover:bg-slate-50" onClick={() => void download()}>
          {t("crt.export")}
        </button>
        <label className="flex items-center gap-1 text-xs text-slate-600 cursor-pointer">
          <input type="checkbox" data-testid="review-crt-include-matches" className="rounded border-slate-300" checked={includeMatches} onChange={(e) => setIncludeMatches(e.target.checked)} />
          {t("crt.includeMatches")}
        </label>
        {canEdit && (
          <>
            <button
              type="button"
              data-testid="review-crt-import"
              disabled={importCrt.isPending}
              className="px-3 py-1 text-xs border border-slate-200 rounded-lg cursor-pointer hover:bg-slate-50 disabled:opacity-50"
              onClick={() => fileRef.current?.click()}
            >
              {t("crt.import")}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".crt,text/plain"
              data-testid="review-crt-file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void choose(file);
              }}
            />
          </>
        )}
      </div>
      {exported && (
        <p data-testid="review-crt-exported" className="mt-2 text-xs text-slate-500">
          {t("crt.exported", exported)}
        </p>
      )}
      {note && <p className="mt-2 text-xs text-slate-500">{note}</p>}

      {preview && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div data-testid="review-crt-preview" className="bg-white rounded-xl p-6 max-w-lg w-full shadow-lg max-h-[85vh] overflow-y-auto text-sm">
            <h2 className="font-semibold text-slate-900 mb-3">{t("crt.previewTitle", { fileName: preview.fileName })}</h2>
            {preview.result.decisions.length > 0 ? (
              <>
                <p className="text-slate-700">{t("crt.previewDecisions", { count: preview.result.decisions.length })}</p>
                <ul className="mt-1 mb-3 list-disc pl-5 text-slate-700">
                  {preview.result.decisions.map((d) => (
                    <li key={d.symbolIdx} data-testid="review-crt-decision">
                      {"accept" in d
                        ? t("crt.previewAccept", { code: codeOf(d.symbolIdx), name: entryName(d.accept) })
                        : t("crt.previewKeep", { code: codeOf(d.symbolIdx) })}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-slate-700 mb-3">{t("crt.previewNothing")}</p>
            )}
            {preview.result.unchanged.length > 0 && (
              <p className="text-slate-500 mb-3">{t("crt.previewUnchanged", { count: preview.result.unchanged.length })}</p>
            )}
            {preview.result.skipped.length > 0 && (
              <>
                <p className="text-slate-700">{t("crt.previewSkipped", { count: preview.result.skipped.length })}</p>
                <ul className="mt-1 mb-3 text-xs text-slate-600 space-y-0.5">
                  {preview.result.skipped.map((s, i) => (
                    <li key={i} data-testid="review-crt-skipped">
                      {t("crt.previewLine", { line: s.line })}: <code>{s.code}</code> {s.message}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {preview.result.warnings.length > 0 && (
              <ul className="mb-3 text-xs text-amber-700 space-y-0.5">
                {preview.result.warnings.map((w) => (
                  <li key={w.code}>
                    <code>{w.code}</code> ×{w.count}: {w.message}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-slate-500 mb-4">{t("clubWide")}</p>
            <div className="flex justify-end gap-2">
              <button type="button" data-testid="review-crt-cancel" className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg cursor-pointer" onClick={() => setPreview(null)}>
                {t("crt.cancel")}
              </button>
              {preview.result.decisions.length > 0 && (
                <button
                  type="button"
                  data-testid="review-crt-confirm"
                  disabled={importCrt.isPending}
                  className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg cursor-pointer disabled:opacity-50"
                  onClick={() => void confirm()}
                >
                  {t("crt.confirm")}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
