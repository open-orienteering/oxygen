/**
 * PrinterSettingsDialog — modal for inspecting and reconfiguring the
 * connected receipt printer.
 *
 * Currently scoped to the CITIZEN CT-S310II, which is the only printer
 * whose memory switch layout we know empirically. For other printers the
 * dialog shows identity only and explains that configuration isn't
 * supported.
 *
 * Two main capabilities:
 *  1. Flip the printer between Virtual COM and Printer Class USB modes
 *     (MSW5-3) without needing the printer's FEED-button setup mode.
 *  2. Print the printer's built-in self-test, useful for verifying the
 *     change took effect after a power-cycle.
 *
 * Borrowed-equipment workflow: any flash is recorded in localStorage so
 * the dialog can later prompt the operator to flip the printer back to
 * its original mode before returning it.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { usePrinter } from "../context/PrinterContext.js";
import {
  CITIZEN_USB_MODE_SWITCH,
  type CitizenUsbMode,
} from "../lib/receipt-printer/index.js";
import {
  clearRecord,
  getRecord,
  type PrinterFlashRecord,
} from "../lib/printer-flash-history.js";

interface Props {
  open: boolean;
  onClose: () => void;
}

type SwitchReadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; switches: Record<number, string> }
  | { kind: "error"; message: string };

type FlashState =
  | { kind: "idle" }
  | { kind: "flashing"; targetMode: CitizenUsbMode }
  | { kind: "flashed"; targetMode: CitizenUsbMode };

export function PrinterSettingsDialog({ open, onClose }: Props): ReactNode {
  const { t } = useTranslation("devices");
  const printer = usePrinter();
  const { connected, identity, supportsRead, readAllMemorySwitches, flashUsbMode, printSelfTest } = printer;
  const [switchState, setSwitchState] = useState<SwitchReadState>({ kind: "idle" });
  const [flashState, setFlashState] = useState<FlashState>({ kind: "idle" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [borrowedRecord, setBorrowedRecord] = useState<PrinterFlashRecord | null>(null);

  const isCtS310II = identity?.ctS310IIMode != null;
  const usbMode = identity?.ctS310IIMode ?? null;

  const refreshBorrowedRecord = useCallback(() => {
    if (!identity) {
      setBorrowedRecord(null);
      return;
    }
    setBorrowedRecord(getRecord(identity.vendorId, identity.serialNumber));
  }, [identity]);

  useEffect(() => {
    if (open) {
      refreshBorrowedRecord();
      setActionError(null);
      setSwitchState({ kind: "idle" });
      setFlashState({ kind: "idle" });
    }
  }, [open, refreshBorrowedRecord]);

  const handleReadSwitches = useCallback(async () => {
    if (!supportsRead) return;
    setSwitchState({ kind: "loading" });
    try {
      const switches = await readAllMemorySwitches();
      setSwitchState({ kind: "ok", switches });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSwitchState({ kind: "error", message: t("readFailed", { message }) });
    }
  }, [supportsRead, readAllMemorySwitches, t]);

  const handleFlash = useCallback(
    async (targetMode: CitizenUsbMode, currentMode: CitizenUsbMode) => {
      setActionError(null);
      setFlashState({ kind: "flashing", targetMode });
      try {
        await flashUsbMode(targetMode, currentMode);
        refreshBorrowedRecord();
        setFlashState({ kind: "flashed", targetMode });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setFlashState({ kind: "idle" });
        setActionError(t("flashFailed", { message }));
      }
    },
    [flashUsbMode, refreshBorrowedRecord, t],
  );

  const handlePrintSelfTest = useCallback(async () => {
    setActionError(null);
    try {
      await printSelfTest();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setActionError(t("selfTestFailed", { message }));
    }
  }, [printSelfTest, t]);

  const handleDismissBorrowed = useCallback(() => {
    if (!identity) return;
    clearRecord(identity.vendorId, identity.serialNumber);
    refreshBorrowedRecord();
  }, [identity, refreshBorrowedRecord]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className="relative bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        data-testid="printer-settings-dialog"
      >
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">
            {t("printerSettingsTitle")}
          </h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 cursor-pointer"
            aria-label={t("cancel")}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {!connected ? (
            <p className="text-sm text-slate-600">{t("printerNotConnected")}</p>
          ) : (
            <IdentitySection
              identity={identity}
              borrowedRecord={borrowedRecord}
              onDismissBorrowed={handleDismissBorrowed}
            />
          )}

          {connected && !isCtS310II && (
            <p className="text-sm text-slate-600">{t("printerNotSupported")}</p>
          )}

          {connected && isCtS310II && usbMode && (
            <ModeSection
              usbMode={usbMode}
              flashState={flashState}
              onFlash={handleFlash}
              onClose={onClose}
            />
          )}

          {actionError && (
            <p
              className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800"
              data-testid="printer-action-error"
            >
              {actionError}
            </p>
          )}

          {connected && isCtS310II && supportsRead && (
            <MemorySwitchesSection
              state={switchState}
              onRead={handleReadSwitches}
              usbMode={usbMode}
            />
          )}

          {connected && (
            <SelfTestSection onPrint={handlePrintSelfTest} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub-sections ─────────────────────────────────────────────

function IdentitySection({
  identity,
  borrowedRecord,
  onDismissBorrowed,
}: {
  identity: { vendorId: number; productId: number; productName: string | null; serialNumber: string | null } | null;
  borrowedRecord: PrinterFlashRecord | null;
  onDismissBorrowed: () => void;
}) {
  const { t } = useTranslation("devices");
  if (!identity) return null;
  const fmtHex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(4, "0")}`;
  return (
    <section>
      <h3 className="text-sm font-semibold text-slate-700 mb-2">{t("printerIdentity")}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-slate-500">{t("name")}</dt>
        <dd className="text-slate-900 font-medium">{identity.productName ?? t("unknownPrinter")}</dd>
        <dt className="text-slate-500">{t("vendorId")}</dt>
        <dd className="text-slate-900 tabular-nums">{fmtHex(identity.vendorId)}</dd>
        <dt className="text-slate-500">{t("productId")}</dt>
        <dd className="text-slate-900 tabular-nums">{fmtHex(identity.productId)}</dd>
        <dt className="text-slate-500">{t("serialNumber")}</dt>
        <dd className="text-slate-900 tabular-nums">
          {identity.serialNumber && identity.serialNumber !== "00000000"
            ? identity.serialNumber
            : t("noSerial")}
        </dd>
      </dl>
      {borrowedRecord && borrowedRecord.currentMode !== borrowedRecord.originalMode && (
        <BorrowedWarning record={borrowedRecord} onDismiss={onDismissBorrowed} />
      )}
    </section>
  );
}

function BorrowedWarning({
  record,
  onDismiss,
}: {
  record: PrinterFlashRecord;
  onDismiss: () => void;
}) {
  const { t } = useTranslation("devices");
  const fromLabel = t(record.originalMode === "virtual-com" ? "modeVirtualCom" : "modePrinterClass");
  const toLabel = t(record.currentMode === "virtual-com" ? "modeVirtualCom" : "modePrinterClass");
  return (
    <div
      className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
      data-testid="printer-borrowed-warning"
    >
      <p className="font-medium">{t("borrowedWarningTitle")}</p>
      <p className="mt-1">
        {t("borrowedWarningBody", {
          from: fromLabel,
          to: toLabel,
          when: new Date(record.flashedAt).toLocaleString(),
        })}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-2 text-xs text-amber-700 underline hover:text-amber-900 cursor-pointer"
      >
        {t("dismissBorrowedWarning")}
      </button>
    </div>
  );
}

function ModeSection({
  usbMode,
  flashState,
  onFlash,
  onClose,
}: {
  usbMode: CitizenUsbMode;
  flashState: FlashState;
  onFlash: (target: CitizenUsbMode, current: CitizenUsbMode) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("devices");

  if (flashState.kind === "flashing") {
    return <p className="text-sm text-slate-500">{t("flashing")}</p>;
  }

  if (flashState.kind === "flashed") {
    const targetLabel = t(flashState.targetMode === "virtual-com" ? "modeVirtualCom" : "modePrinterClass");
    return (
      <div
        className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900"
        data-testid="printer-flash-success"
      >
        <p className="font-semibold">{t("flashSuccessTitle")}</p>
        <p className="mt-1">{t("flashSuccessBody", { mode: targetLabel })}</p>
        <button
          type="button"
          onClick={onClose}
          className="mt-3 inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 cursor-pointer"
        >
          {t("powerCycleAcknowledge")}
        </button>
      </div>
    );
  }

  // flashState.kind === "idle"
  const currentLabel = t(usbMode === "virtual-com" ? "modeVirtualCom" : "modePrinterClass");
  const currentDescription = t(usbMode === "virtual-com" ? "modeVirtualComDescription" : "modePrinterClassDescription");
  const otherMode: CitizenUsbMode = usbMode === "virtual-com" ? "printer-class" : "virtual-com";
  const otherLabel = t(otherMode === "virtual-com" ? "modeVirtualCom" : "modePrinterClass");
  const switchAction = otherMode === "virtual-com" ? "switchToVirtualCom" : "switchToPrinterClass";

  return (
    <section>
      <h3 className="text-sm font-semibold text-slate-700 mb-2">{t("currentMode")}</h3>
      <div className="rounded-lg border border-slate-200 p-3 mb-3">
        <p className="text-sm font-medium text-slate-900">{currentLabel}</p>
        <p className="mt-1 text-xs text-slate-600">{currentDescription}</p>
      </div>

      <FlashButtonWithConfirm
        actionLabel={t(switchAction)}
        targetMode={otherMode}
        targetLabel={otherLabel}
        usbMode={usbMode}
        onFlash={onFlash}
      />
    </section>
  );
}

function FlashButtonWithConfirm({
  actionLabel,
  targetMode,
  targetLabel,
  usbMode,
  onFlash,
}: {
  actionLabel: string;
  targetMode: CitizenUsbMode;
  targetLabel: string;
  usbMode: CitizenUsbMode;
  onFlash: (target: CitizenUsbMode, current: CitizenUsbMode) => void;
}) {
  const { t } = useTranslation("devices");
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md border border-blue-600 text-blue-700 hover:bg-blue-50 cursor-pointer"
        data-testid="printer-flash-button"
      >
        {actionLabel}
      </button>
    );
  }

  return (
    <div
      className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
      data-testid="printer-flash-confirm"
    >
      <p className="font-semibold">{t("switchModeConfirmTitle")}</p>
      <p className="mt-1">{t("switchModeConfirmBody")}</p>
      <p className="mt-2">
        {t("switchModeConfirmBodyBorrowed", { mode: t(usbMode === "virtual-com" ? "modeVirtualCom" : "modePrinterClass") })}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setConfirming(false);
            onFlash(targetMode, usbMode);
          }}
          className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md bg-amber-600 text-white hover:bg-amber-700 cursor-pointer"
          data-testid="printer-flash-confirm-button"
        >
          {t("confirm")} — {targetLabel}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md border border-amber-600 text-amber-800 hover:bg-amber-100 cursor-pointer"
        >
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}

function MemorySwitchesSection({
  state,
  onRead,
  usbMode,
}: {
  state: SwitchReadState;
  onRead: () => void;
  usbMode: CitizenUsbMode | null;
}) {
  const { t } = useTranslation("devices");
  const isVirtualCom = usbMode === "virtual-com";
  return (
    <section data-testid="printer-memory-switches">
      <h3 className="text-sm font-semibold text-slate-700 mb-2">{t("memorySwitches")}</h3>
      {state.kind === "idle" && (
        <>
          <p className="text-xs text-slate-600 mb-2">
            {isVirtualCom ? t("memorySwitchesIdleNoteVirtualCom") : t("memorySwitchesIdleNote")}
          </p>
          <button
            type="button"
            onClick={onRead}
            className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer"
            data-testid="printer-read-switches-button"
          >
            {t("readMemorySwitches")}
          </button>
        </>
      )}
      {state.kind === "loading" && (
        <p className="text-sm text-slate-500">{t("loadingMemorySwitches")}</p>
      )}
      {state.kind === "error" && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900">
          <p>{state.message}</p>
          <p className="mt-1 text-xs">{t("memorySwitchesUnsupportedNote")}</p>
          <button
            type="button"
            onClick={onRead}
            className="mt-2 text-xs underline hover:opacity-80 cursor-pointer"
          >
            {t("retry")}
          </button>
        </div>
      )}
      {state.kind === "ok" && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm tabular-nums">
          {Object.entries(state.switches)
            .map(([n, bits]) => [Number(n), bits] as const)
            .sort(([a], [b]) => a - b)
            .map(([n, bits]) => (
              <FragmentRow
                key={n}
                label={t("memorySwitchSw", { n })}
                value={bits}
                highlight={n === CITIZEN_USB_MODE_SWITCH}
              />
            ))}
        </dl>
      )}
    </section>
  );
}

function FragmentRow({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight: boolean;
}) {
  return (
    <>
      <dt className={highlight ? "text-blue-700 font-semibold" : "text-slate-500"}>{label}</dt>
      <dd className={highlight ? "text-blue-900 font-mono" : "text-slate-900 font-mono"}>{value}</dd>
    </>
  );
}

function SelfTestSection({ onPrint }: { onPrint: () => void | Promise<void> }) {
  const { t } = useTranslation("devices");
  return (
    <section>
      <h3 className="text-sm font-semibold text-slate-700 mb-2">{t("printSelfTest")}</h3>
      <p className="text-xs text-slate-600 mb-2">{t("printSelfTestDescription")}</p>
      <button
        type="button"
        onClick={() => void onPrint()}
        className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer"
        data-testid="printer-self-test-button"
      >
        {t("printSelfTest")}
      </button>
      <p className="mt-2 text-xs text-amber-700">{t("printSelfTestDisconnectNote")}</p>
      <p className="mt-2 text-xs text-slate-500">{t("printChangeListNote")}</p>
    </section>
  );
}
