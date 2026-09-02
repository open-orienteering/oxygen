import { useCallback, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { LanguageSelector } from "../components/LanguageSelector";
import { UserChip } from "../components/UserChip";
import { fileToBase64 } from "../lib/file-to-base64";
import { useCurrentUser } from "../context/CurrentUserContext";
import { LibraryControlsTab } from "./LibraryControlsTab";
import { LibraryGroupsTab } from "./LibraryGroupsTab";
import { LibraryClassesTab } from "./LibraryClassesTab";

function formatScale(scale: number | null): string {
  if (scale == null || !Number.isFinite(scale)) return "";
  const rounded = Math.round(scale);
  return `1:${rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function LibraryPage() {
  const { t, i18n } = useTranslation("library");
  const { user, authEnabled } = useCurrentUser();
  const utils = trpc.useUtils();
  const maps = trpc.clubMap.list.useQuery();
  const upload = trpc.clubMap.upload.useMutation({
    onSuccess: () => void utils.clubMap.list.invalidate(),
  });
  const rename = trpc.clubMap.rename.useMutation({
    onSuccess: () => void utils.clubMap.list.invalidate(),
  });
  const remove = trpc.clubMap.remove.useMutation({
    onSuccess: () => {
      setPendingDelete(null);
      void utils.clubMap.list.invalidate();
    },
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [tab, setTab] = useState<"maps" | "controls" | "classes" | "groups">("maps");

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith(".ocd")) return;
      setUploadError(null);
      try {
        const fileDataBase64 = await fileToBase64(file);
        await upload.mutateAsync({ fileName: file.name, fileDataBase64 });
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : String(err));
      }
    },
    [upload],
  );

  const canManageSource = (uploadedBy: string | null) => {
    if (!authEnabled) return true;
    if (!user) return false;
    return user.isAdmin || uploadedBy === user.id;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-end mb-2 items-center gap-3">
          <UserChip />
          <LanguageSelector />
        </div>
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">{t("title")}</h1>
            <Link
              to="/"
              className="text-sm text-blue-600 hover:text-blue-800"
            >
              {t("backToEvents")}
            </Link>
          </div>
        </div>

        <nav
          data-testid="library-tabs"
          className="flex gap-2 border-b border-slate-200 mb-6"
        >
          <button
            type="button"
            data-testid="library-tab-maps"
            className={`px-3 py-2 text-sm font-medium border-b-2 cursor-pointer ${
              tab === "maps"
                ? "text-blue-700 border-blue-600"
                : "text-slate-500 border-transparent hover:text-slate-700"
            }`}
            onClick={() => setTab("maps")}
          >
            {t("tabMaps")}
          </button>
          <button
            type="button"
            data-testid="library-tab-controls"
            className={`px-3 py-2 text-sm font-medium border-b-2 cursor-pointer ${
              tab === "controls"
                ? "text-blue-700 border-blue-600"
                : "text-slate-500 border-transparent hover:text-slate-700"
            }`}
            onClick={() => setTab("controls")}
          >
            {t("tabControls")}
          </button>
          <button
            type="button"
            data-testid="library-tab-classes"
            className={`px-3 py-2 text-sm font-medium border-b-2 cursor-pointer ${
              tab === "classes"
                ? "text-blue-700 border-blue-600"
                : "text-slate-500 border-transparent hover:text-slate-700"
            }`}
            onClick={() => setTab("classes")}
          >
            {t("tabClasses")}
          </button>
          <button
            type="button"
            data-testid="library-tab-groups"
            className={`px-3 py-2 text-sm font-medium border-b-2 cursor-pointer ${
              tab === "groups"
                ? "text-blue-700 border-blue-600"
                : "text-slate-500 border-transparent hover:text-slate-700"
            }`}
            onClick={() => setTab("groups")}
          >
            {t("tabGroups")}
          </button>
        </nav>

        {tab === "groups" ? (
          <LibraryGroupsTab />
        ) : tab === "classes" ? (
          <LibraryClassesTab />
        ) : tab === "controls" ? (
          <LibraryControlsTab />
        ) : (
          <>
        <p className="text-sm text-slate-600 mb-4">{t("mapsHelp")}</p>

        <div
          data-testid="library-dropzone"
          className={`border-2 border-dashed rounded-xl p-6 text-center mb-6 transition-colors ${
            dragOver ? "border-blue-400 bg-blue-50" : "border-slate-200 bg-white"
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files[0];
            if (file) void handleFile(file);
          }}
        >
          <p className="text-sm text-slate-500 mb-2">{t("dropMapHere")}</p>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 cursor-pointer"
          >
            {t("uploadMap")}
          </button>
          <input
            ref={fileInputRef}
            data-testid="library-map-upload"
            type="file"
            accept=".ocd"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
              e.target.value = "";
            }}
          />
          {upload.isPending && (
            <div className="mt-2 text-xs text-blue-600">{t("uploading")}</div>
          )}
          {uploadError && (
            <div className="mt-2 text-xs text-red-600">{uploadError}</div>
          )}
        </div>

        {maps.data && maps.data.length === 0 && (
          <p className="text-sm text-slate-500 text-center py-8">{t("emptyMaps")}</p>
        )}

        <ul className="space-y-3">
          {(maps.data ?? []).map((row) => (
            <li
              key={row.id}
              data-testid={`library-map-card-${row.id}`}
              className="bg-white rounded-xl border border-slate-200 p-4 flex gap-4"
            >
              <img
                src={`/api/club-map-preview/${row.id}`}
                data-testid="club-map-preview"
                alt=""
                className="h-20 w-28 flex-none rounded border border-slate-200 object-contain bg-white"
                onError={(event) => {
                  event.currentTarget.hidden = true;
                }}
              />
              <div className="min-w-0 flex-1">
              {editingId === row.id ? (
                <form
                  className="mb-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!editName.trim()) return;
                    rename.mutate({ id: row.id, name: editName.trim() });
                    setEditingId(null);
                  }}
                >
                  <input
                    data-testid="library-map-rename"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full px-2 py-1 border border-slate-200 rounded text-sm"
                    autoFocus
                    onBlur={() => {
                      if (editName.trim() && editName.trim() !== row.name) {
                        rename.mutate({ id: row.id, name: editName.trim() });
                      }
                      setEditingId(null);
                    }}
                  />
                </form>
              ) : (
                <button
                  type="button"
                  data-testid="library-map-name"
                  className="font-semibold text-slate-900 text-left cursor-pointer hover:text-blue-700"
                  onClick={() => {
                    setEditingId(row.id);
                    setEditName(row.name);
                  }}
                >
                  {row.name}
                </button>
              )}
              <div className="mt-1 text-xs text-slate-500 flex flex-wrap gap-x-3 gap-y-1">
                <span>
                  {t("fileName")}: {row.fileName}
                </span>
                <span>
                  {t("size")}: {formatBytes(row.sizeBytes)}
                </span>
                <span>
                  {t("scale")}: {formatScale(row.scale) || t("noScale")}
                </span>
                {authEnabled && (
                  <span>
                    {t("uploadedBy")}:{" "}
                    {row.uploader?.displayName ||
                      row.uploader?.email ||
                      t("unknownUploader")}
                  </span>
                )}
                <span>
                  {t("uploadedAt")}:{" "}
                  {new Date(row.uploadedAt).toLocaleString(i18n.language)}
                </span>
              </div>
              <div className="mt-3 flex gap-2">
                {canManageSource(row.uploadedBy) && (
                <button
                  type="button"
                  data-testid="library-map-download"
                  className="px-3 py-1 text-xs border border-slate-200 rounded-lg cursor-pointer hover:bg-slate-50"
                  onClick={async () => {
                    const file = await utils.clubMap.download.fetch({ id: row.id });
                    const bin = atob(file.fileDataBase64);
                    const bytes = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                    const href = URL.createObjectURL(new Blob([bytes]));
                    const a = document.createElement("a");
                    a.href = href;
                    a.download = file.fileName;
                    a.click();
                    URL.revokeObjectURL(href);
                  }}
                >
                  {t("download")}
                </button>
                )}
                {canManageSource(row.uploadedBy) && (
                  <button
                    type="button"
                    data-testid="library-map-delete"
                    className="px-3 py-1 text-xs text-red-600 border border-red-100 rounded-lg cursor-pointer hover:bg-red-50"
                    onClick={() => setPendingDelete({ id: row.id, name: row.name })}
                  >
                    {t("delete")}
                  </button>
                )}
              </div>
              </div>
            </li>
          ))}
        </ul>
          </>
        )}
      </div>

      {pendingDelete && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div
            data-testid="library-delete-confirm"
            className="bg-white rounded-xl p-6 max-w-sm w-full shadow-lg"
          >
            <h2 className="font-semibold text-slate-900 mb-2">{t("deleteTitle")}</h2>
            <p className="text-sm text-slate-600 mb-4">
              {t("deleteBody", { name: pendingDelete.name })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg cursor-pointer"
                onClick={() => setPendingDelete(null)}
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                data-testid="library-delete-confirm-btn"
                className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg cursor-pointer"
                onClick={() => remove.mutate({ id: pendingDelete.id })}
              >
                {t("confirmDelete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
