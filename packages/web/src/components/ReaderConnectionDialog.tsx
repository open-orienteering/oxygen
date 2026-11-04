/**
 * Reader connection dialog: lists every card reader the DeviceManager knows
 * and adds new ones. Rendered by DeviceManagerProvider while
 * `readerDialogOpen` is true, so the competition header and the kiosk open
 * the same dialog.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDeviceManager } from "../context/DeviceManager";
import type { ReaderInfo } from "../lib/reader-hub";

const isLive = (r: ReaderInfo) => r.status === "connected" || r.status === "reading";

export function ReaderConnectionDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("devices");
  const {
    readers,
    serialSupported,
    bleSupport,
    connectReader,
    disconnectReader,
    removeReader,
    forgetReader,
    reconnectReader,
  } = useDeviceManager();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // An unconnected USB station with no history is just the placeholder
  // ControlsPage keeps for station programming; it is not worth a row. A
  // Reader BT always gets one, so it can be reconnected or forgotten.
  const visible = readers.filter(
    (r) => r.kind === "ble" || r.status !== "idle" || r.lastCardAt != null,
  );

  // One reader is the common case: get out of the way as soon as the reader
  // just added is live. `connectReader` itself resolves only after the
  // station's configuration handshake, which can take a few seconds.
  const liveBeforeAdd = useRef<Set<string> | null>(null);
  useEffect(() => {
    const before = liveBeforeAdd.current;
    if (!before) return;
    if (readers.some((r) => isLive(r) && !before.has(r.id))) {
      liveBeforeAdd.current = null;
      onClose();
    }
  }, [readers, onClose]);

  const add = async (kind: "serial" | "ble") => {
    setError(null);
    setBusy(true);
    liveBeforeAdd.current = new Set(readers.filter(isLive).map((r) => r.id));
    try {
      await connectReader(kind);
    } catch (err) {
      liveBeforeAdd.current = null;
      const e = err as Error;
      // Cancelling the browser's picker is not an error worth showing.
      if (e?.name !== "NotFoundError") {
        setError(t("readerConnectFailed", { message: e?.message ?? String(err) }));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reader-dialog-title"
        className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        data-testid="reader-dialog"
      >
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 id="reader-dialog-title" className="text-lg font-semibold text-slate-900">
            {t("readerDialogTitle")}
          </h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 cursor-pointer"
            aria-label={t("close", { ns: "common" })}
            data-testid="reader-dialog-close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-6">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
              {t("connectedReaders")}
            </h3>
            {visible.length === 0 ? (
              <p className="text-sm text-slate-500" data-testid="no-readers">
                {t("noReadersConnected")}
              </p>
            ) : (
              <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                {visible.map((r) => (
                  <ReaderRow
                    key={r.id}
                    reader={r}
                    onDisconnect={() => disconnectReader(r.id)}
                    onRemove={() => removeReader(r.id)}
                    onForget={() => forgetReader(r.id)}
                    onReconnect={() => reconnectReader(r.id)}
                  />
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
              {t("addReader")}
            </h3>
            <div className="space-y-2">
              <button
                onClick={() => add("serial")}
                disabled={!serialSupported || busy}
                className={ADD_BUTTON}
                data-testid="connect-reader"
              >
                <UsbIcon className="w-5 h-5 mt-0.5 text-slate-500 shrink-0" />
                <span>
                  <span className="block text-sm font-medium text-slate-900">{t("addUsbStation")}</span>
                  <span className="block text-xs text-slate-500">
                    {serialSupported ? t("addUsbStationHint") : t("serialUnsupported")}
                  </span>
                </span>
              </button>
              <button
                onClick={() => add("ble")}
                disabled={bleSupport !== "ok" || busy}
                className={ADD_BUTTON}
                data-testid="connect-reader-bt"
              >
                <BluetoothIcon className="w-5 h-5 mt-0.5 text-slate-500 shrink-0" />
                <span>
                  <span className="block text-sm font-medium text-slate-900">{t("addBtReader")}</span>
                  <span className="block text-xs text-slate-500" data-testid="connect-reader-bt-hint">
                    {t(BLE_HINT[bleSupport])}
                  </span>
                </span>
              </button>
            </div>
          </section>

          <details className="text-sm text-slate-600" data-testid="reader-bt-help">
            <summary className="cursor-pointer font-medium text-slate-700">{t("btHelpTitle")}</summary>
            <ul className="mt-2 ml-4 list-disc space-y-1 text-xs">
              <li>{t("btHelpWake")}</li>
              <li>{t("btHelpNoPair")}</li>
              <li>{t("btHelpLinux")}</li>
            </ul>
          </details>

          {error && (
            <p
              className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800"
              data-testid="reader-connect-error"
            >
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

const ADD_BUTTON =
  "w-full flex items-start gap-3 text-left p-3 border border-slate-200 rounded-lg hover:border-blue-400 hover:bg-blue-50 disabled:opacity-50 disabled:hover:bg-white disabled:hover:border-slate-200 disabled:cursor-not-allowed cursor-pointer transition-colors";

const BLE_HINT = {
  ok: "addBtReaderHint",
  checking: "addBtReaderHint",
  unsupported: "btUnsupported",
  insecure: "btInsecure",
  "no-adapter": "btNoAdapter",
} as const;

function ReaderRow({
  reader,
  onDisconnect,
  onRemove,
  onForget,
  onReconnect,
}: {
  reader: ReaderInfo;
  onDisconnect: () => void;
  onRemove: () => void;
  onForget: () => void;
  onReconnect: () => void;
}) {
  const { t } = useTranslation("devices");
  const live = isLive(reader);
  const ble = reader.kind === "ble";
  const meta = [
    reader.info?.serial ? t("readerSerial", { serial: reader.info.serial }) : null,
    reader.info?.firmware ? t("readerFirmware", { firmware: reader.info.firmware }) : null,
    ble && reader.info?.batteryPercent != null
      ? t("readerBattery", { percent: reader.info.batteryPercent })
      : null,
    reader.lastCardAt
      ? t("readerLastCard", { time: new Date(reader.lastCardAt).toLocaleTimeString() })
      : null,
  ].filter(Boolean);

  return (
    <li className="p-3" data-testid={`reader-row-${reader.kind}`} data-reader-id={reader.id}>
      <div className="flex items-center gap-3">
        {ble ? (
          <BluetoothIcon className="w-5 h-5 text-slate-500 shrink-0" />
        ) : (
          <UsbIcon className="w-5 h-5 text-slate-500 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-slate-900 truncate">{reader.label}</div>
          <div className="text-xs text-slate-500 flex flex-wrap gap-x-2">
            <span>{t(ble ? "readerKindBle" : "readerKindUsb")}</span>
            {meta.map((m) => (
              <span key={m}>· {m}</span>
            ))}
          </div>
        </div>
        <StatusChip status={reader.status} />
        {live ? (
          <button
            onClick={onDisconnect}
            className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded cursor-pointer"
            data-testid="disconnect-reader"
          >
            {t("disconnect", { ns: "common" })}
          </button>
        ) : ble ? (
          reader.status === "idle" && (
            <button
              onClick={onReconnect}
              className="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded cursor-pointer"
              data-testid="reconnect-reader"
            >
              {t("reconnectReader")}
            </button>
          )
        ) : (
          <button
            onClick={onRemove}
            className="text-xs text-slate-600 hover:bg-slate-100 px-2 py-1 rounded cursor-pointer"
            data-testid="remove-reader"
          >
            {t("removeReader")}
          </button>
        )}
        {ble && (
          <button
            onClick={onForget}
            className="text-xs text-slate-600 hover:bg-slate-100 px-2 py-1 rounded cursor-pointer"
            data-testid="forget-reader"
          >
            {t("forgetReader")}
          </button>
        )}
      </div>
      {ble && !live && (
        <p className="mt-2 text-xs text-slate-500" data-testid="reader-bt-state-hint">
          {t(
            reader.status === "error"
              ? "readerBtReconnecting"
              : reader.status === "connecting"
                ? "readerBtWaiting"
                : "readerBtAsleep",
          )}
        </p>
      )}
      {live && reader.info?.mode && reader.info.mode !== "readout" && (
        <p
          className="mt-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2"
          data-testid="reader-mode-warning"
        >
          {t(ble ? "readerModeWarningBt" : "readerModeWarning")}
        </p>
      )}
    </li>
  );
}

function StatusChip({ status }: { status: ReaderInfo["status"] }) {
  const { t } = useTranslation("devices");
  const tone =
    status === "reading" || status === "connected"
      ? "bg-emerald-50 text-emerald-700"
      : status === "connecting"
        ? "bg-blue-50 text-blue-700"
        : status === "error"
          ? "bg-red-50 text-red-700"
          : "bg-slate-100 text-slate-600";
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${tone}`}
      data-testid="reader-status-chip"
    >
      {status === "reading" && <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />}
      {t(`readerStatus_${status}`)}
    </span>
  );
}

function UsbIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v14m0 0a2 2 0 100 4 2 2 0 000-4zm0-14l-2 2m2-2l2 2M7 9v3a2 2 0 002 2h3m5-6v2a2 2 0 01-2 2h-3M6 7h2v2H6zM16 6a1 1 0 112 0 1 1 0 01-2 0z" />
    </svg>
  );
}

function BluetoothIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 7l10 10-5 4V3l5 4L7 17" />
    </svg>
  );
}
