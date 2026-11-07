/**
 * Uploading or replacing the event's map, and taking one from the club
 * library (docs/map-storage.md §5, docs/club-library.md "Copy-on-use"). One
 * hook for both places that do it: `MapPanel`'s drop zone (no map yet) and the
 * course editor's map-info dialog (`pages/editor/MapInfoDialog.tsx`, P6). Each
 * caller has its own state (progress, error, the north-lines notice, the
 * picker); a success refreshes `course.mapFileInfo` and `course.mapMetadata`
 * through the query cache, so every view of the map follows either caller.
 */

import { useCallback, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { trpc } from "../lib/trpc";
import { uploadMapFileChunked } from "../lib/map-upload";
import { useCurrentUser } from "../context/CurrentUserContext";
import { formatStalenessDeg, isMeridianStale } from "../lib/north-lines";

export function useMapReplace() {
  const { nameId } = useParams<{ nameId: string }>();
  const { t: tl } = useTranslation("library");
  const { user, authEnabled } = useCurrentUser();
  const utils = trpc.useUtils();

  const [error, setError] = useState<string | null>(null);
  // True from the first chunk until the map is applied (or fails).
  const [uploading, setUploading] = useState(false);
  // Non-blocking: shown once after an upload whose drawn north lines have drifted from today's magnetic north.
  // The map-info dialog's badge carries the same information afterwards.
  const [notice, setNotice] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const canQueryLibrary = !authEnabled || Boolean(user);
  const clubMaps = trpc.clubMap.list.useQuery(undefined, { enabled: canQueryLibrary, staleTime: 30_000 });

  const noticeFor = useCallback(
    (stalenessDeg: number | null) =>
      isMeridianStale(stalenessDeg) ? tl("northLinesStale", { degrees: formatStalenessDeg(stalenessDeg!) }) : null,
    [tl],
  );
  const refresh = useCallback(() => {
    void utils.course.mapFileInfo.invalidate();
    void utils.course.mapMetadata.invalidate();
  }, [utils]);

  // Second half of the upload (docs/map-storage.md §5): the bytes are already in map_sources; this makes them the
  // event map.
  const applyUploaded = trpc.course.applyUploadedMap.useMutation({
    onSuccess: (result) => {
      setError(null);
      setNotice(noticeFor(result.meridianStalenessDeg));
      refresh();
    },
    onError: (err) => setError(`Map upload failed: ${err.message}`),
  });
  const useClubMap = trpc.course.useClubMap.useMutation({
    onSuccess: (result) => {
      setPickerOpen(false);
      setError(null);
      setNotice(noticeFor(result.meridianStalenessDeg));
      refresh();
    },
    onError: (err) => setError(`Map upload failed: ${err.message}`),
  });

  // Every failure path has to end in `error`. Returning quietly leaves the caller looking untouched, which reads
  // as "the click did nothing": the user cannot tell a rejected file from a lost one.
  const handleFile = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith(".ocd")) {
      setError(`Map upload failed: ${file.name} is not an .ocd file`);
      return;
    }
    setError(null);
    setNotice(null);
    setUploading(true);
    // Every file goes up in 8 MiB chunks (Cloud Run's request ceiling, resumable per chunk) and is applied by hash
    // afterwards.
    void uploadMapFileChunked(file, { eventNameId: nameId ?? null })
      .then(({ fileHash }) => applyUploaded.mutateAsync({ fileHash, fileName: file.name }))
      .catch((err: unknown) => setError(`Map upload failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setUploading(false));
  }, [applyUploaded, nameId]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const onFileChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Cleared so choosing the same file again (after a failure) fires another change.
    e.target.value = "";
    if (file) handleFile(file);
  }, [handleFile]);

  const dismissNotice = useCallback(() => setNotice(null), []);
  const openFilePicker = useCallback(() => fileInputRef.current?.click(), []);
  const { mutate: adopt } = useClubMap;
  const pick = useCallback((clubMapId: string) => adopt({ clubMapId }), [adopt]);

  return {
    uploading,
    error,
    notice,
    dismissNotice,
    handleFile,
    /** Opens the browser's file chooser (`accept=".ocd"`); render `fileInput` once. */
    openFilePicker,
    /** The hidden file input's props: `<input {...fileInput} />`. */
    fileInput: { ref: fileInputRef, type: "file", accept: ".ocd", className: "hidden", onChange: onFileChange } as const,
    library: {
      /** The club library lists at least one map (the action shows only then). */
      available: (clubMaps.data?.length ?? 0) > 0,
      maps: clubMaps.data ?? [],
      open: pickerOpen,
      setOpen: setPickerOpen,
      pick,
      pending: useClubMap.isPending,
    },
  };
}

export type MapReplace = ReturnType<typeof useMapReplace>;
