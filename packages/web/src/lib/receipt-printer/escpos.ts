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
import type { FinishReceiptData, RegistrationReceiptData, FinishReceiptLabels, RegistrationReceiptLabels } from "./types.js";

const DEFAULT_FINISH_LABELS: Required<FinishReceiptLabels> = {
  start: "Start",
  finish: "Finish",
  splitHeader: "Nr.  Cod  Split      Time  Total  Pace",
  fin: "Fin",
  battery: "Battery",
  position: "Position",
  competitionInfo: "Competition information:",
  tagline: "Lightweight orienteering management",
  missing: "--- MISSING ---",
};

const DEFAULT_REG_LABELS: Required<RegistrationReceiptLabels> = {
  registration: "REGISTRATION",
  receipt: "Receipt",
  name: "Name:",
  club: "Club:",
  class: "Class:",
  siCard: "SI Card:",
  start: "Start:",
  freeStart: "Free start",
  payment: "Payment:",
  amount: "Amount:",
  printed: "Printed",
  tagline: "Lightweight orienteering management",
  entryFee: "Entry fee",
  vatExempt: "VAT exempt",
  vat: "VAT",
  total: "TOTAL",
  friskvardNote: "Valid for friskvardsbidrag",
  date: "Date:",
  participant: "Participant:",
  entryFeeSubtitle: "ENTRY FEE",
  paymentMethod: "Payment method:",
  rentalCardFee: "Rental card",
};

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
  // Box-drawing characters (PC437)
  0x2500: 0xC4, // ─ horizontal
  0x2502: 0xB3, // │ vertical
  0x250C: 0xDA, // ┌ top-left
  0x2510: 0xBF, // ┐ top-right
  0x2514: 0xC0, // └ bottom-left
  0x2518: 0xD9, // ┘ bottom-right
  0x251C: 0xC3, // ├ left-tee
  0x2524: 0xB4, // ┤ right-tee
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
  /** Set line spacing to n dots (ESC 3 n). 24 = character cell height (eliminates gaps in box-drawing). */
  setLineSpacing(n: number): this { return this.raw(0x1b, 0x33, n & 0xff); }
  /** Reset line spacing to printer default (ESC 2). */
  resetLineSpacing(): this { return this.raw(0x1b, 0x32); }
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

  /** Full-width separator line using box-drawing horizontal (centered). */
  separator(): this { return this.alignCenter().line("─".repeat(LINE_WIDTH)).alignLeft(); }

  /** Box top border: ┌──...──┐ */
  boxTop(): this { return this.line("┌" + "─".repeat(LINE_WIDTH - 2) + "┐"); }
  /** Box bottom border: └──...──┘ */
  boxBottom(): this { return this.line("└" + "─".repeat(LINE_WIDTH - 2) + "┘"); }
  /** Box divider: ├──...──┤ */
  boxDivider(): this { return this.line("├" + "─".repeat(LINE_WIDTH - 2) + "┤"); }
  /** Line inside box with borders: │ text              │ */
  boxLine(s: string): this {
    const inner = LINE_WIDTH - 4;
    const padded = s.length > inner ? s.slice(0, inner) : s + " ".repeat(inner - s.length);
    return this.line("│ " + padded + " │");
  }
  /** Double-height only (no double-width). For tall borders that match double-size content. */
  sizeDoubleHeight(): this { return this.raw(0x1d, 0x21, 0x01); }

  /** Line inside box with double-size bold text. Borders use double-height to match. */
  boxLineDouble(s: string): this {
    const inner = LINE_WIDTH - 4; // 38 usable single-width columns
    const doubleWidth = s.length * 2;
    const pad = Math.max(0, inner - doubleWidth);
    // Use double-height borders so │ covers the full 48-dot row
    this.sizeDoubleHeight().text("│").sizeNormal().text(" ");
    this.boldOn().sizeDouble().text(s).sizeNormal().boldOff();
    if (pad > 0) this.text(" ".repeat(pad));
    this.text(" ").sizeDoubleHeight().text("│").sizeNormal();
    return this.lf();
  }

  /** Two-column line inside box: │ left        right │ */
  boxLeftRight(left: string, right: string): this {
    const inner = LINE_WIDTH - 4;
    const gap = inner - left.length - right.length;
    const content = gap > 0 ? left + " ".repeat(gap) + right : (left + " " + right).slice(0, inner);
    return this.line("│ " + content + " │");
  }

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

/** Format a whole-number amount as Swedish receipt format: "120,00 kr". */
function formatAmountSEK(amount: number): string {
  return `${amount},00 kr`;
}

// ─── Receipt builder ─────────────────────────────────────────

/** Build a finish receipt as ESC/POS bytes ready to send to a printer. */
export function buildFinishReceipt(data: FinishReceiptData): Uint8Array {
  const L = { ...DEFAULT_FINISH_LABELS, ...data.labels };
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
  b.line(`  ${L.start}: ${formatMeosTime(startTime)}   ${L.finish}: ${formatMeosTime(finishTime)}`);

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
    b.line(L.splitHeader);

    for (const split of data.splits) {
      const idx = String(split.controlIndex + 1).padStart(2) + ".";
      const code = String(split.controlCode).padStart(4);

      if (split.status === "missing") {
        b.line(`${idx} ${code}  ${L.missing}`);
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
    b.boldOn().line(`${L.fin.padEnd(3)}      ${finSplitFmt}  ${finClock} ${finCum} ${finPace}`).boldOff();
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
    b.line(`  ${L.battery}: ${voltStr}   ${dateStr}   ${okStr}`);
    b.separator();
  }

  // ── Position + class results ─────────────────────────────────
  if (data.position) {
    const posLabel = `${data.position.rank}/${data.position.total}`;
    b.boldOn().line(`  ${L.position}: ${posLabel}`).boldOff();
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
    b.line(L.competitionInfo);
    b.qrCode(data.qrUrl, 5);
    b.lf();
  }

  // ── Footer ───────────────────────────────────────────────────
  b.alignCenter();
  b.boldOn().line("Oxygen").boldOff();
  b.line(L.tagline);
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
  const L = { ...DEFAULT_REG_LABELS, ...data.labels };
  const b = new EscPosBuilder();
  b.init();
  b.lf();

  // Use the enhanced kvitto layout when org number is configured
  const kvittoMode = !!data.orgNumber;

  // ── Logo ──────────────────────────────────────────────────────
  if (data.logoRaster) {
    b.alignCenter();
    b.rasterImage(data.logoRaster.widthBytes, data.logoRaster.heightDots, data.logoRaster.data);
    b.lf();
    b.alignLeft();
  }

  // ── Header (same style as finish receipt) ─────────────────────
  b.alignCenter();
  for (const nameLine of wordWrap(data.competitionName, Math.floor(LINE_WIDTH / 2))) {
    b.sizeDouble().boldOn().line(nameLine).boldOff().sizeNormal();
  }
  if (data.competitionDate) {
    b.feedDots(8);
    b.line(data.competitionDate);
  }
  b.alignLeft();

  // ── Organizer details (kvitto mode) ───────────────────────────
  if (kvittoMode) {
    b.lf();
    b.alignCenter();
    const org = data.organizerDetails;
    const orgName = org?.name || data.organizerName;
    if (orgName) b.line(orgName);
    if (org?.street) b.line(org.street);
    const zipCity = [org?.zip, org?.city].filter(Boolean).join(" ");
    if (zipCity) b.line(zipCity);
    b.line(`Org.nr: ${data.orgNumber}`);
    if (org?.email) b.line(org.email);
    b.alignLeft();
  }

  b.separator();

  // ── Title ─────────────────────────────────────────────────────
  b.lf();
  b.alignCenter();
  b.boldOn();
  b.sizeDouble();
  b.line(kvittoMode ? L.receipt : L.registration);
  b.sizeNormal();
  b.boldOff();
  if (kvittoMode) {
    b.feedDots(12);
    b.line(L.entryFeeSubtitle);
  }
  // Full datetime
  const now = new Date();
  const dateTimeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  b.line(dateTimeStr);
  b.alignLeft();
  b.lf();
  b.separator();

  // ── Runner info ───────────────────────────────────────────────
  b.lf();
  b.leftRight(L.participant, data.runner.name);
  if (data.runner.clubName) b.leftRight(L.club, data.runner.clubName);
  b.leftRight(L.class, data.runner.className);
  b.leftRight(L.siCard, String(data.runner.cardNo));
  b.leftRight(L.start, data.startTime || L.freeStart);
  b.lf();

  // ── Financial section (kvitto mode) ────────────────────────────
  if (kvittoMode && data.payment) {
    b.separator();
    b.lf();
    const entryFeeAmount = data.payment.amount - (data.payment.cardFee ?? 0);
    b.leftRight(L.entryFee, formatAmountSEK(entryFeeAmount));
    if (data.payment.cardFee) {
      b.leftRight(L.rentalCardFee, formatAmountSEK(data.payment.cardFee));
    }
    const vatExempt = data.vatInfo?.exempt ?? true;
    if (vatExempt) {
      b.line(`${L.vat}: 0,00 kr (${L.vatExempt})`);
    }
    b.lf();
    b.separator();

    // ── Payment box with amount + method ─────────────────────────
    b.alignCenter();
    b.setLineSpacing(24);
    b.boxTop();
    b.boxLine("");
    // Double-size line needs 48-dot advance to match its height
    b.setLineSpacing(48);
    b.boxLineDouble(`${L.amount.replace(/:$/, "")}  ${formatAmountSEK(data.payment.amount)}`);
    b.setLineSpacing(24);
    b.boxLine("");
    b.boxLine(`${L.paymentMethod} ${data.payment.method}`);
    b.boxBottom();
    b.resetLineSpacing();
    b.alignLeft();
  } else if (!kvittoMode && data.payment) {
    b.separator();
    b.leftRight(L.payment, data.payment.method);
    b.leftRight(L.amount, formatAmountSEK(data.payment.amount));
    if (data.payment.cardFee) {
      b.leftRight(L.rentalCardFee, formatAmountSEK(data.payment.cardFee));
    }
  }

  if (!kvittoMode) b.separator();

  // ── Friskvardsbidrag note ─────────────────────────────────────
  if (kvittoMode && data.friskvardNote) {
    b.lf();
    b.alignCenter();
    b.line(L.friskvardNote);
    b.alignLeft();
  }

  // ── Custom message ───────────────────────────────────────────
  if (data.customMessage) {
    b.lf();
    b.alignCenter();
    for (const line of wordWrap(data.customMessage, LINE_WIDTH)) {
      b.line(line);
    }
    b.alignLeft();
  }

  // ── Footer (same as finish receipt) ────────────────────────────
  b.lf();
  b.alignCenter();
  const timestamp = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  b.line(`${L.printed} ${timestamp}`);
  b.lf();
  b.boldOn().line("Oxygen").boldOff();
  b.line(L.tagline);
  b.line("open-orienteering.org");
  b.lf();
  b.alignLeft();

  b.cut();
  return b.build();
}
