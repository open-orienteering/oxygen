/**
 * Maps on this device (G17): *Make maps available offline* for the three
 * surfaces that offer it (Export ▾, the Courses page's export menu, the
 * sync panel — docs/course-print.md §8.6 "Offline"), the event's document
 * prefetch and its "offline ready" lines (docs/map-storage.md §7.1). The
 * store step itself is in the print chunk (`print/offline-prepare.ts`),
 * loaded on first use.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { trpc } from "../lib/trpc";
import { ensureSheetsBestEffort } from "../lib/trpc-links";
import { isMapDocumentStored, prefetchMapDocument, storagePersisted } from "../lib/map-document-cache";
import { useCapabilities } from "../context/CapabilitiesContext";
import { deviceEnv, deviceLimit } from "../print/capability";
import {
  offlinePrintProgress,
  offlinePrintStore,
  type OfflinePrintManifest,
  type OfflinePrintProgress,
  subscribeOfflinePrint,
} from "../print/offline-store";
import type { OfflinePrintErrorCode } from "../print/client";
import type { PrepareResult } from "../print/offline-prepare";

/** The code of an `OfflinePrintError` (the print client's), null for any other error. */
export function offlinePrintErrorCode(err: unknown): OfflinePrintErrorCode | null {
  if (!err || typeof err !== "object" || (err as { name?: unknown }).name !== "OfflinePrintError") return null;
  const code = (err as { code?: unknown }).code;
  return code === "notStored" || code === "tooLarge" || code === "unsupported" || code === "failed" ? code : null;
}

/** The store step failed for another reason than the network (`OfflinePrepareError`): a translated message, the cause on the console. */
export function isOfflinePrepareError(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { name?: unknown }).name === "OfflinePrepareError";
}

/** A stored time (ISO) as the user's date and time. */
export function formatStoredAt(iso: string, language: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString(language, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return d.toLocaleString();
  }
}

/** The event's running store step, null when none runs. */
export function useOfflinePrintProgress(nameId: string): OfflinePrintProgress | null {
  return useSyncExternalStore(subscribeOfflinePrint, () => offlinePrintProgress(nameId));
}

/** The event's manifest, re-read whenever a run ends. */
export function useOfflinePrintManifest(nameId: string | undefined): OfflinePrintManifest | null {
  const [manifest, setManifest] = useState<OfflinePrintManifest | null>(null);
  useEffect(() => {
    if (!nameId) return;
    let live = true;
    const read = () => void offlinePrintStore.readManifest(nameId).then((m) => { if (live) setManifest(m); });
    read();
    const off = subscribeOfflinePrint(() => { if (!offlinePrintProgress(nameId)) read(); });
    return () => {
      live = false;
      off();
    };
  }, [nameId]);
  return manifest;
}

/**
 * The explicit action: under `courses.edit` the sheets are ensured first
 * (as *All courses* and *All controls*), then the store step runs.
 */
export function useStoreMapsOffline(nameId: string, canEdit: boolean): () => Promise<PrepareResult> {
  const utils = trpc.useUtils();
  return useCallback(async () => {
    const ensure = canEdit
      ? async () => {
          const a = await ensureSheetsBestEffort(() => utils.client.layout.autoSheets.mutate({}));
          const b = await ensureSheetsBestEffort(() => utils.client.layout.autoSheets.mutate({ allControls: true }));
          if ([a, b].some((r) => r && (r.createdSheets.length || r.createdTemplates.length))) {
            void utils.courseMap.list.invalidate();
            void utils.mapTemplate.list.invalidate();
            void utils.layout.classOverrides.invalidate();
          }
        }
      : undefined;
    const { prepareOfflinePrint } = await import("../print/offline-prepare");
    return prepareOfflinePrint(nameId, { ensure });
  }, [nameId, canEdit, utils]);
}

export interface EventOfflineMaps {
  /** The user may print (`courses.view`) and the event has a pinned document. */
  shown: boolean;
  documentStored: boolean;
  manifest: OfflinePrintManifest | null;
  persisted: boolean;
  /** `deviceLimit` 0: the device cannot compose PDFs. */
  unsupported: boolean;
  progress: OfflinePrintProgress | null;
}

/**
 * The sync indicator's part (mounted on every event page): prefetches the
 * event's document once it is known, and reads the lines of the *Maps on
 * this device* block; `persisted` and the stored state are re-read when
 * `refreshKey` changes (the panel opening).
 */
export function useEventOfflineMaps(nameId: string | undefined, refreshKey: unknown): EventOfflineMaps {
  const canView = useCapabilities().has("courses.view");
  const meta = trpc.course.mapMetadata.useQuery(undefined, { enabled: !!nameId && canView, staleTime: 60_000 });
  const hash = meta.data?.documentHash ?? null;
  const [documentStored, setDocumentStored] = useState(false);
  const [persisted, setPersisted] = useState(false);
  const manifest = useOfflinePrintManifest(nameId);
  const progress = useOfflinePrintProgress(nameId ?? "");
  const running = progress !== null;

  useEffect(() => {
    if (!hash || !nameId) return;
    let live = true;
    void prefetchMapDocument(hash, nameId).then((ok) => { if (live) setDocumentStored(ok); });
    return () => { live = false; };
  }, [hash, nameId]);

  useEffect(() => {
    let live = true;
    void storagePersisted().then((p) => { if (live) setPersisted(p); });
    if (hash) void isMapDocumentStored(hash).then((s) => { if (live) setDocumentStored(s); });
    return () => { live = false; };
    // Re-read when a run ends (`running` falls).
  }, [hash, refreshKey, running]);

  return {
    shown: canView && !!hash,
    documentStored,
    manifest,
    persisted,
    unsupported: deviceLimit(deviceEnv()) <= 0,
    progress,
  };
}
