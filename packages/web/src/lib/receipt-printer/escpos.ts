/**
 * ESC/POS receipt encoder.
 *
 * Generates raw ESC/POS byte sequences for finish result receipts.
 * Transport-agnostic — pass the resulting Uint8Array to any PrinterDriver.
 *
 * Targets 80mm paper (42 chars per line at standard font).
 *
 * Character encoding: PC437 / CP850 byte values.
 * Both code pages share the same byte positions for Swedish characters:
 *   ä=0x84  å=0x86  ö=0x94  Ä=0x8E  Å=0x8F  Ö=0x99
 * These differ from Latin-1 (where ö=0xF6 etc.), so we map explicitly.
 * PC437 is the ESC/POS default after ESC @ reset, so no code page command is needed.
 */

import { formatMeosTime, formatRunningTime, runnerStatusLabel } from "@oxygen/shared";
import type { RunnerStatusValue } from "@oxygen/shared";
import type { FinishReceiptData, RegistrationReceiptData } from "./types.js";

// Standard line width for 80mm paper at default font size
const LINE_WIDTH = 42;

// ─── ESC/POS character encoding ──────────────────────────────
//
// PC437 and CP850 share the same bytes for the common Western European
// characters below. Characters not in this map fall back to '?' (0x3F).

const UNICODE_TO_ESCPOS: Record<number, number> = {
  // Swedish / Nordic — same positions in PC437 and CP850
  0x00C4: 0x8E, // Ä
  0x00C5: 0x8F, // Å
  0x00D6: 0x99, // Ö
  0x00E4: 0x84, // ä
  0x00E5: 0x86, // å
  0x00F6: 0x94, // ö
  // Other common European (present in CP850 but not always in PC437)
  0x00C0: 0xB7, // À
  0x00C1: 0xB5, // Á
  0x00C2: 0xB6, // Â
  0x00C7: 0x80, // Ç
  0x00C9: 0x90, // É
  0x00CB: 0xD3, // Ë
  0x00CD: 0xD6, // Í
  0x00D1: 0xA5, // Ñ
  0x00D3: 0xE0, // Ó
  0x00D4: 0xE2, // Ô
  0x00D8: 0x9D, // Ø
  0x00DA: 0xE9, // Ú
  0x00DC: 0x9A, // Ü
  0x00DF: 0xE1, // ß
  0x00E0: 0x85, // à
  0x00E1: 0xA0, // á
  0x00E2: 0x83, // â
  0x00E6: 0x91, // æ
  0x00E7: 0x87, // ç
  0x00E8: 0x8A, // è
  0x00E9: 0x82, // é
  0x00EA: 0x88, // ê
  0x00EB: 0x89, // ë
  0x00ED: 0xA1, // í
  0x00F1: 0xA4, // ñ
  0x00F3: 0xA2, // ó
  0x00F4: 0x93, // ô
  0x00F8: 0x9B, // ø
  0x00F9: 0x97, // ù
  0x00FA: 0xA3, // ú
  0x00FB: 0x96, // û
  0x00FC: 0x81, // ü
};

// ─── ESC/POS Builder ─────────────────────────────────────────

class EscPosBuilder {
  private buf: number[] = [];

  raw(...bytes: number[]): this {
    this.buf.push(...bytes);
    return this;
  }

  /** Printer initialization — resets to defaults (code page → PC437). */
  init(): this { return this.raw(0x1b, 0x40); }

  alignLeft(): this { return this.raw(0x1b, 0x61, 0x00); }
  alignCenter(): this { return this.raw(0x1b, 0x61, 0x01); }
  boldOn(): this { return this.raw(0x1b, 0x45, 0x01); }
  boldOff(): this { return this.raw(0x1b, 0x45, 0x00); }
  /** Double-width + double-height text (GS ! 0x11). Resets with sizeNormal(). */
  sizeDouble(): this { return this.raw(0x1d, 0x21, 0x11); }
  /** Reset to normal text size (GS ! 0x00). */
  sizeNormal(): this { return this.raw(0x1d, 0x21, 0x00); }
  /** Feed paper by exactly n dots (ESC J n, ~n/180 inch). For small gaps between elements. */
  feedDots(n: number): this { return this.raw(0x1b, 0x4a, n & 0xff); }
  lf(): this { return this.raw(0x0a); }

  /** Partial cut with 10-dot paper feed. */
  cut(): this { return this.raw(0x1d, 0x56, 0x42, 0x0a); }

  /**
   * Encode a string as ESC/POS (PC437/CP850) bytes and append (no newline).
   * ASCII 0x00–0x7F passes through unchanged.
   * Extended characters are mapped via UNICODE_TO_ESCPOS; unmapped → '?'.
   */
  text(s: string): this {
    for (const char of s) {
      const code = char.charCodeAt(0);
      if (code < 0x80) {
        this.buf.push(code);
      } else {
        this.buf.push(UNICODE_TO_ESCPOS[code] ?? 0x3F);
      }
    }
    return this;
  }

  /** Text + line feed. */
  line(s: string): this { return this.text(s).lf(); }

  /** Full-width separator line. */
  separator(): this { return this.line("=".repeat(LINE_WIDTH)); }

  /** Center-align a string within LINE_WIDTH (no printer alignment command). */
  centered(s: string): this {
    const pad = Math.max(0, Math.floor((LINE_WIDTH - s.length) / 2));
    return this.line(" ".repeat(pad) + s);
  }

  /** Print left and right strings with spaces filling the gap to LINE_WIDTH. */
  leftRight(left: string, right: string): this {
    const gap = LINE_WIDTH - left.length - right.length;
    if (gap <= 0) return this.line(left.slice(0, LINE_WIDTH));
    return this.line(left + " ".repeat(gap) + right);
  }

  /**
   * Print a 1-bit raster image using GS v 0 (normal density, 203 dpi).
   * Use alignCenter() before this call to center the image on the paper.
   */
  rasterImage(widthBytes: number, heightDots: number, data: Uint8Array): this {
    const xL = widthBytes & 0xFF, xH = (widthBytes >> 8) & 0xFF;
    const yL = heightDots & 0xFF, yH = (heightDots >> 8) & 0xFF;
    this.raw(0x1D, 0x76, 0x30, 0x00, xL, xH, yL, yH);
    for (const byte of data) this.buf.push(byte);
    return this;
  }

  /**
   * Print a QR code using the ESC/POS GS ( k command sequence.
   * @param text  The string to encode (URL, plain text, etc.)
   * @param size  Module size 1–8 (default 5 ≈ 18 mm at 203 dpi)
   */
  qrCode(text: string, size = 5): this {
    const data = Array.from(new TextEncoder().encode(text));
    const storeLen = data.length + 3; // +3 for cn(1) + fn(1) + m(1)
    const pL = storeLen & 0xFF, pH = (storeLen >> 8) & 0xFF;
    this.raw(0x1D, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00); // model 2
    this.raw(0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, size);         // module size
    this.raw(0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x31);         // error correction M
    this.raw(0x1D, 0x28, 0x6B, pL, pH, 0x31, 0x50, 0x30, ...data);    // store data
    this.raw(0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30);         // print
    return this;
  }

  build(): Uint8Array { return new Uint8Array(this.buf); }
}

// ─── Formatting helpers ───────────────────────────────────────

/** Split a string into lines of at most maxLen chars, breaking at whitespace. */
function wordWrap(s: string, maxLen: number): string[] {
  if (s.length <= maxLen) return [s];
  const lines: string[] = [];
  let remaining = s;
  while (remaining.length > maxLen) {
    const slice = remaining.slice(0, maxLen);
    const lastSpace = slice.lastIndexOf(" ");
    if (lastSpace > 0) {
      lines.push(remaining.slice(0, lastSpace));
      remaining = remaining.slice(lastSpace + 1);
    } else {
      lines.push(slice);
      remaining = remaining.slice(maxLen);
    }
  }
  if (remaining) lines.push(remaining);
  return lines;
}

/** deciseconds since midnight → "HH:MM:SS" */
function formatClock(ds: number): string {
  if (ds <= 0) return "        "; // 8 spaces when unknown
  const totalSec = Math.floor(ds / 10);
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/**
 * Compute min/km pace and format as "M:SS".
 * pace_min_per_km = (splitTime_ds / 600) / (legLength_m / 1000)
 *                 = splitTime_ds / (legLength_m * 0.6)
 * Returns empty string if data is unavailable or implausible.
 */
function formatPace(legLength: number, splitDs: number): string {
  if (!legLength || !splitDs || splitDs <= 0) return "";
  const minPerKm = splitDs / (legLength * 0.6);
  if (minPerKm > 99) return ""; // implausibly slow — bad data
  const mins = Math.floor(minPerKm);
  let secs = Math.round((minPerKm - mins) * 60);
  let adjustedMins = mins;
  if (secs >= 60) { secs -= 60; adjustedMins += 1; }
  return `${adjustedMins}:${String(secs).padStart(2, "0")}`;
}

// ─── Receipt builder ─────────────────────────────────────────

/** Build a finish receipt as ESC/POS bytes ready to send to a printer. */
export function buildFinishReceipt(data: FinishReceiptData): Uint8Array {
  const b = new EscPosBuilder();

  b.init();
  b.lf();

  // ── Logo ──────────────────────────────────────────────────────
  if (data.logoRaster) {
    b.alignCenter();
    b.rasterImage(data.logoRaster.widthBytes, data.logoRaster.heightDots, data.logoRaster.data);
    b.lf();
    b.alignLeft();
  }

  // ── Header ──────────────────────────────────────────────────
  // Use printer's built-in alignment (alignCenter) without manual padding.
  b.alignCenter();
  for (const nameLine of wordWrap(data.competitionName, Math.floor(LINE_WIDTH / 2))) {
    b.sizeDouble().boldOn().line(nameLine).boldOff().sizeNormal();
  }
  if (data.competitionDate) {
    b.feedDots(8);
    b.line(data.competitionDate);
  }
  b.alignLeft();
  b.separator();

  // ── Runner info ─────────────────────────────────────────────
  b.boldOn().line(`  ${data.runner.name}  ${data.runner.className}`).boldOff();
  if (data.runner.clubName) b.line(`  ${data.runner.clubName}`);
  b.separator();

  // ── Status line ─────────────────────────────────────────────
  const { startTime, finishTime, runningTime, status } = data.timing;
  b.line(`  Start: ${formatMeosTime(startTime)}   Finish: ${formatMeosTime(finishTime)}`);

  const statusLabel = runnerStatusLabel(status as RunnerStatusValue);
  const tidStr = formatRunningTime(runningTime);
  let statusLine = `  ${statusLabel}  Time: ${tidStr}`;
  if (data.course && data.course.length > 0) {
    const overallPace = formatPace(data.course.length, runningTime);
    if (overallPace) statusLine += `  (${overallPace} min/km)`;
  }
  b.boldOn().line(statusLine).boldOff();
  b.separator();

  // ── Splits ──────────────────────────────────────────────────
  //
  // Column layout (38 chars total):
  //   pos  0- 2  Nr   (3) — right-aligned control number + "."
  //   pos  3     _    (1) — space
  //   pos  4- 7  Cod  (4) — right-aligned control code
  //   pos  8     _    (1) — space
  //   pos  9-14  Spl  (6) — right-aligned split time (m:ss)
  //   pos 15-16  __   (2) — two spaces (extra margin before clock)
  //   pos 17-24  Time (8) — clock time HH:MM:SS
  //   pos 25     _    (1) — space
  //   pos 26-31  Tot  (6) — right-aligned cumulative time
  //   pos 32     _    (1) — space
  //   pos 33-37  Pace (5) — right-aligned min/km pace
  if (data.splits.length > 0) {
    // Each header label right-aligned to its column's right edge
    b.line("Nr.  Cod  Split      Time  Total  Pace");

    for (const split of data.splits) {
      const idx = String(split.controlIndex + 1).padStart(2) + ".";
      const code = String(split.controlCode).padStart(4);

      if (split.status === "missing") {
        b.line(`${idx} ${code}  --- MISSING ---`);
      } else {
        const splitFmt = formatRunningTime(split.splitTime).padStart(6);
        const clockFmt = (split.punchTime && split.punchTime > 0)
          ? formatClock(split.punchTime)
          : "        ";
        const cumFmt = formatRunningTime(split.cumTime).padStart(6);
        const pace = (split.legLength && split.legLength > 0 && split.splitTime > 0)
          ? formatPace(split.legLength, split.splitTime).padStart(5)
          : "    -";
        b.line(`${idx} ${code} ${splitFmt}  ${clockFmt} ${cumFmt} ${pace}`);
      }
    }

    // Fin row — "Fin" (3) + 6 spaces aligns to split column at pos 9
    const lastSplit = data.splits[data.splits.length - 1];
    const finSplitDs = (lastSplit && lastSplit.status !== "missing") ? lastSplit.splitTime : 0;
    const finSplitFmt = finSplitDs > 0 ? formatRunningTime(finSplitDs).padStart(6) : "      ";
    const finClock = finishTime > 0 ? formatClock(finishTime) : "        ";
    const finCum = formatRunningTime(runningTime).padStart(6);
    const finPace = (lastSplit && lastSplit.legLength && lastSplit.legLength > 0 && finSplitDs > 0)
      ? formatPace(lastSplit.legLength, finSplitDs).padStart(5)
      : "    -";
    b.boldOn().line(`Fin      ${finSplitFmt}  ${finClock} ${finCum} ${finPace}`).boldOff();
    b.separator();
  }

  // ── SIAC battery ─────────────────────────────────────────────
  if (data.siac) {
    const cardNo = data.runner.cardNo ?? 0;
    if (cardNo > 0) b.line(`  SIAC ${cardNo}`);
    const voltStr = data.siac.voltage != null
      ? `${data.siac.voltage.toFixed(2)}V`
      : "-.--V";
    const dateStr = data.siac.batteryDate ?? "";
    const okStr = data.siac.batteryOk ? "OK" : "LOW";
    b.line(`  Battery: ${voltStr}   ${dateStr}   ${okStr}`);
    b.separator();
  }

  // ── Position + class results ─────────────────────────────────
  if (data.position) {
    const posLabel = `${data.position.rank}/${data.position.total}`;
    b.boldOn().line(`  Position: ${posLabel}`).boldOff();
  }
  if (data.classResults && data.classResults.length > 0) {
    for (const r of data.classResults) {
      const timeFmt = formatRunningTime(r.runningTime);
      const right = `${timeFmt}  `;
      const maxLeft = LINE_WIDTH - right.length - 1; // at least 1 gap space
      const prefix = `  ${r.rank}  `;
      const clubShort = r.clubName.length > 10 ? r.clubName.slice(0, 9) + "." : r.clubName;
      const withClub = `${prefix}${r.name} (${clubShort})`;
      const withoutClub = `${prefix}${r.name}`;
      let left: string;
      if (withClub.length <= maxLeft) {
        left = withClub;
      } else if (withoutClub.length <= maxLeft) {
        left = withoutClub;
      } else {
        left = withoutClub.slice(0, maxLeft);
      }
      b.leftRight(left, right);
    }
    b.separator();
  }

  // ── Custom message ───────────────────────────────────────────
  if (data.customMessage) {
    b.alignCenter();
    for (const line of wordWrap(data.customMessage, LINE_WIDTH)) {
      b.line(line);
    }
    b.alignLeft();
    b.separator();
  }

  // ── QR code ───────────────────────────────────────────────────
  if (data.qrUrl) {
    b.alignCenter();
    b.line("Competition information:");
    b.qrCode(data.qrUrl, 5);
    b.lf();
  }

  // ── Footer ───────────────────────────────────────────────────
  b.alignCenter();
  b.boldOn().line("Oxygen").boldOff();
  b.line("Lightweight orienteering management");
  b.line("open-orienteering.org");
  const now = new Date();
  const timestamp = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  b.line(timestamp);
  b.lf();

  // ── Cut ──────────────────────────────────────────────────────
  b.cut();

  return b.build();
}

// ─── Registration Receipt ─────────────────────────────────────

export function buildRegistrationReceipt(data: RegistrationReceiptData): Uint8Array {
  const b = new EscPosBuilder();
  b.init();

  // ── Logo ──────────────────────────────────────────────────────
  if (data.logoRaster) {
    b.alignCenter();
    b.rasterImage(data.logoRaster.widthBytes, data.logoRaster.heightDots, data.logoRaster.data);
    b.feedDots(10);
    b.alignLeft();
  }

  // ── Header ────────────────────────────────────────────────────
  b.alignCenter();
  b.sizeDouble();
  b.line(data.competitionName);
  b.sizeNormal();
  if (data.competitionDate) b.line(data.competitionDate);
  b.lf();
  b.boldOn();
  b.line("REGISTRATION");
  b.boldOff();
  b.alignLeft();
  b.separator();

  // ── Runner info ───────────────────────────────────────────────
  b.leftRight("Name:", data.runner.name);
  if (data.runner.clubName) b.leftRight("Club:", data.runner.clubName);
  b.leftRight("Class:", data.runner.className);
  b.leftRight("SI Card:", String(data.runner.cardNo));
  b.leftRight("Start:", data.startTime || "Free start");
  b.separator();

  // ── Payment ───────────────────────────────────────────────────
  if (data.payment) {
    b.leftRight("Payment:", data.payment.method);
    b.leftRight("Amount:", `${data.payment.amount} kr`);
    b.separator();
  }

  // ── Custom message ───────────────────────────────────────────
  if (data.customMessage) {
    b.lf();
    b.alignCenter();
    for (const line of wordWrap(data.customMessage, LINE_WIDTH)) {
      b.line(line);
    }
    b.alignLeft();
    b.separator();
  }

  // ── Footer ────────────────────────────────────────────────────
  b.lf();
  b.alignCenter();
  const timestamp = new Date().toLocaleString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  b.line(`Printed ${timestamp}`);
  b.lf();
  b.alignLeft();

  b.cut();
  return b.build();
}
