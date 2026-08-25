import { ControlStatus, type AutosendMode, type RadioType } from "@oxygen/shared";
import { AUTOSEND_MODE, type AutosendMode as WireAutosendMode } from "./si-protocol";

/**
 * Whether the autosend selection means anything for a control with this
 * status.
 *
 * A clear station has nothing worth transmitting, and a readout station
 * always gets the PROTO autosend gate regardless of the selection — that
 * gate is how the host receives readouts at all. Everything else (normal
 * controls, start, finish, check) reads cards into results and can push
 * them over SRR radio.
 */
export function statusSupportsAutosend(status: number): boolean {
  return status !== ControlStatus.Clear && status !== ControlStatus.Readout;
}

/**
 * Resolve the wire-level autosend value for a control about to be
 * programmed.
 *
 * Radio type is the gate, not AIR+: SRR transmission and contactless
 * punching are separate features, so a plain control or a check station
 * with an SRR module autosends without ever entering beacon mode.
 */
export function resolveAutosendMode(args: {
  status: number;
  radioType: RadioType | null | undefined;
  autosendMode?: AutosendMode | null;
}): WireAutosendMode {
  const hasRadio =
    args.radioType === "internal_radio" || args.radioType === "public_radio";
  if (!hasRadio || !statusSupportsAutosend(args.status)) {
    return AUTOSEND_MODE.OFF;
  }
  switch (args.autosendMode) {
    case "all":
      return AUTOSEND_MODE.SEND_ALL;
    case "unsent":
      return AUTOSEND_MODE.SEND_UNSENT;
    default:
      return AUTOSEND_MODE.SEND_LAST;
  }
}
