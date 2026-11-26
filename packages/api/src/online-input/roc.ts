/**
 * ROC (Radio Online Control) protocol implementation.
 *
 * Spec: a polled HTTP GET, plain-text semicolon-separated response.
 *
 *   GET {endpoint}?unitId={X}&lastId={N}&date=YYYY-MM-DD&time=HH:MM:SS
 *   → punchId;controlCode;cardNo;YYYY-MM-DD HH:MM:SS\n  (one row per punch)
 *
 * No auth — the URL + unitId is the entire credential. The remote returns
 * only rows with id > lastId, ordered by id ascending.
 *
 * Mirrors MeOS `code/onlineinput.cpp` `Type::ROC` branch (lines 519-524 for
 * the request, 796-835 for response handling).
 */

import {
  type Protocol,
  type ProtocolConfig,
  type PollEvent,
  type RemotePunch,
  type ParseResult,
  type BuildRequestResult,
  formatHMS,
  parseHMS,
} from "./protocol.js";

/**
 * Largest value the punch columns (and the `lastId` watermark) can hold:
 * `punches.card_no` and `punches.control_code` are int4. A row above it
 * would fail the insert and roll back the whole batch, so it is skipped
 * at parse time instead.
 */
export const ROC_MAX_INT = 2_147_483_647;

/**
 * A strictly positive decimal integer that fits int4, or null. Stricter
 * than `parseInt`, which reads `12abc` as 12.
 */
function parseIntField(field: string): number | null {
  const t = field.trim();
  if (!/^\d{1,10}$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n <= ROC_MAX_INT ? n : null;
}

export const ROC_DEFAULT_ENDPOINT = "http://roc.olresultat.se/getpunches.asp";

export const rocProtocol: Protocol = {
  id: "roc",

  buildRequest(cfg: ProtocolConfig, lastId: number, event: PollEvent): BuildRequestResult {
    const url = new URL(cfg.endpointUrl);
    url.searchParams.set("unitId", cfg.unitId);
    url.searchParams.set("lastId", String(lastId));
    url.searchParams.set("date", event.date);
    url.searchParams.set("time", formatHMS(event.zeroTimeDs));
    return { url: url.toString() };
  },

  parseResponse(body: string): ParseResult {
    if (!body) return { punches: [], skipped: 0 };

    // Strip BOM if present and split on any of CRLF / CR / LF.
    const cleaned = body.replace(/^\uFEFF/, "");
    const lines = cleaned.split(/\r\n|\r|\n/);

    const punches: RemotePunch[] = [];
    let skipped = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      const parts = line.split(";");
      if (parts.length < 4) {
        skipped++;
        continue;
      }

      const punchId = parseIntField(parts[0]);
      const rawCode = parseIntField(parts[1]);
      const cardNo = parseIntField(parts[2]);
      // ROC timestamp is "YYYY-MM-DD HH:MM:SS"; we only need the time-of-day.
      const absoluteTimeDs = parseHMS(parts[3].trim());

      if (
        punchId === null || rawCode === null || cardNo === null ||
        !Number.isFinite(absoluteTimeDs)
      ) {
        // Malformed row: skip it and keep the rest. ROC has been observed
        // to emit trailing whitespace and occasional empty lines, and one
        // bad row must never block the punches around it. The puller
        // counts skipped rows and treats a body with nothing but skipped
        // rows (an HTML error page, say) as an error, not a healthy poll.
        skipped++;
        continue;
      }

      punches.push({ punchId, rawCode, cardNo, absoluteTimeDs });
    }
    return { punches, skipped };
  },
};
