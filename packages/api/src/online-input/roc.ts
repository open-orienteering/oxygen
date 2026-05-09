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
  type BuildRequestResult,
  formatHMS,
  parseHMS,
} from "./protocol.js";

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

  parseResponse(body: string): RemotePunch[] {
    if (!body) return [];

    // Strip BOM if present and split on any of CRLF / CR / LF.
    const cleaned = body.replace(/^\uFEFF/, "");
    const lines = cleaned.split(/\r\n|\r|\n/);

    const out: RemotePunch[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      const parts = line.split(";");
      if (parts.length < 4) continue;

      const punchId = parseInt(parts[0], 10);
      const rawCode = parseInt(parts[1], 10);
      const cardNo = parseInt(parts[2], 10);
      const ts = parts[3].trim();
      // ROC timestamp is "YYYY-MM-DD HH:MM:SS"; we only need the time-of-day.
      const absoluteTimeDs = parseHMS(ts);

      if (
        !Number.isFinite(punchId) || punchId <= 0 ||
        !Number.isFinite(rawCode) || rawCode <= 0 ||
        !Number.isFinite(cardNo) || cardNo <= 0 ||
        !Number.isFinite(absoluteTimeDs)
      ) {
        // Malformed row — silently skip. ROC has been observed to emit
        // trailing whitespace and occasional empty lines; throwing here
        // would break perfectly fine punches that came on earlier rows.
        continue;
      }

      out.push({ punchId, rawCode, cardNo, absoluteTimeDs });
    }
    return out;
  },
};
