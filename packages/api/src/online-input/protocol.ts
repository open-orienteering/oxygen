/**
 * Online-input protocol abstraction.
 *
 * Oxygen's online-input subsystem polls a remote service on a fixed interval
 * and inserts new punches into `oPunch`. Different services speak different
 * wire protocols (ROC, SportIdent Center, eventually MIP), but everything
 * around the protocol — interval timing, persistence, control mapping, the
 * MeOS Origin checksum, the EventPage UI — is shared. This file defines the
 * narrow seam each protocol implementation has to fill.
 *
 * Adding a new protocol means: implement `Protocol`, register it in the
 * `protocolById` map below, and add a UI entry in EventPage.
 */

/**
 * Protocol identifiers stored in `online_input_config_<nameId>.protocol`.
 * Adding a new id here requires updating the puller's `protocolById` map
 * and the `OnlineInputPanel` dropdown in the web package.
 */
export type ProtocolId = "roc";

/**
 * Per-competition configuration shared by every protocol.
 *
 * Future protocols (SICenter) may need to tuck protocol-specific fields onto
 * this struct (e.g. `apiKey`). Add them as optional properties; the puller
 * passes the whole config through to `buildRequest` so the protocol can pull
 * out whatever it needs.
 */
export interface ProtocolConfig {
  /** Protocol implementation to use. */
  protocol: ProtocolId;
  /**
   * Fully-qualified poll endpoint. For ROC this defaults to
   * `http://roc.olresultat.se/getpunches.asp`. Configurable so OResults'
   * compatible endpoint also works.
   */
  endpointUrl: string;
  /**
   * Provider-specific account / unit identifier.
   *
   * - ROC: account ID covering all radios under one ROC account, OR a
   *   single device MAC. The protocol does not distinguish — both go in
   *   the same `unitId` query parameter.
   */
  unitId: string;
}

/**
 * Competition context the protocol needs to build a request. The puller
 * resolves these from `oEvent` before calling `buildRequest`.
 */
export interface PollEvent {
  /** Competition date as `YYYY-MM-DD`. */
  date: string;
  /** ZeroTime stored in `oEvent.ZeroTime` (deciseconds since midnight). */
  zeroTimeDs: number;
}

/** A single punch row parsed out of a remote poll response. */
export interface RemotePunch {
  /**
   * Sequence id assigned by the remote service. Used to advance `lastId`
   * so subsequent polls only return new rows.
   */
  punchId: number;
  /**
   * Raw control code as reported by the radio (e.g. 31, 100). The puller
   * applies the user's control mapping to translate this into an `oPunch.Type`
   * — special punches (start=1/finish=2/check=3) override the raw code.
   */
  rawCode: number;
  /** SI card number. */
  cardNo: number;
  /** Absolute time of the punch in deciseconds since midnight. */
  absoluteTimeDs: number;
}

export interface BuildRequestResult {
  url: string;
  /** Optional protocol-specific request headers (e.g. Bearer token). */
  headers?: Record<string, string>;
}

/**
 * Stateless protocol seam. Implementations should not retain state across
 * calls — the puller owns lastId tracking, intervals, etc.
 */
export interface Protocol {
  readonly id: ProtocolId;
  /** Build the GET URL (and any required headers) for the next poll. */
  buildRequest(cfg: ProtocolConfig, lastId: number, event: PollEvent): BuildRequestResult;
  /** Parse the raw response body into zero or more punches. */
  parseResponse(body: string): RemotePunch[];
}

/**
 * Format a deciseconds-since-midnight value as `HH:MM:SS` (matches MeOS's
 * `oEvent::getZeroTime()` formatting that ROC's `time=` query parameter
 * expects).
 */
export function formatHMS(deciseconds: number): string {
  const totalSeconds = Math.floor(deciseconds / 10);
  const h = Math.floor(totalSeconds / 3600) % 24;
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Parse `HH:MM:SS` back into deciseconds since midnight. Tolerates a
 * surrounding date prefix — i.e. `parseHMS("2026-05-05 09:42:13")` is the
 * same as `parseHMS("09:42:13")`. Returns NaN on malformed input.
 */
export function parseHMS(hms: string): number {
  const trimmed = hms.length > 8 ? hms.slice(-8) : hms;
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(trimmed);
  if (!m) return Number.NaN;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  if (h > 23 || mm > 59 || s > 59) return Number.NaN;
  return (h * 3600 + mm * 60 + s) * 10;
}
