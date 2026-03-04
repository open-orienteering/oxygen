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
import type { FinishReceiptData } from "./types.js";

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

  build(): Uint8Array { return new Uint8Array(this.buf); }
}

// ─── Formatting helpers ───────────────────────────────────────

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

  // ── Header ──────────────────────────────────────────────────
  b.alignCenter();
  b.boldOn().centered(data.competitionName).boldOff();
  if (data.competitionDate) {
    b.centered(data.competitionDate);
  }
  b.alignLeft();
  b.separator();

  // ── Runner info ─────────────────────────────────────────────
  b.boldOn().line(`  ${data.runner.name}  ${data.runner.className}`).boldOff();
  if (data.runner.clubName) b.line(`  ${data.runner.clubName}`);
  b.separator();

  // ── Status line ─────────────────────────────────────────────
  const { startTime, finishTime, runningTime, status } = data.timing;
  b.line(`  Start: ${formatMeosTime(startTime)}   Mal: ${formatMeosTime(finishTime)}`);

  const statusLabel = runnerStatusLabel(status as RunnerStatusValue);
  const tidStr = formatRunningTime(runningTime);
  let statusLine = `  ${statusLabel}  Tid: ${tidStr}`;
  if (data.course && data.course.length > 0) {
    const overallPace = formatPace(data.course.length, runningTime);
    if (overallPace) statusLine += `  (${overallPace} t/km)`;
  }
  b.boldOn().line(statusLine).boldOff();
  b.separator();

  // ── Splits ──────────────────────────────────────────────────
  if (data.splits.length > 0) {
    // Column header — 3+5+7+10+7+6 = 38 chars
    b.line("Nr.  Kod   Splitt      Kl.   Tot  t/km");

    for (const split of data.splits) {
      const idx = String(split.controlIndex + 1).padStart(2) + ".";
      const code = String(split.controlCode).padStart(4);

      if (split.status === "missing") {
        b.line(`${idx} ${code}  --- SAKNAS ---`);
      } else {
        const splitFmt = formatRunningTime(split.splitTime).padStart(6);
        const clockFmt = (split.punchTime && split.punchTime > 0)
          ? formatClock(split.punchTime)
          : "        ";
        const cumFmt = formatRunningTime(split.cumTime).padStart(6);
        const pace = (split.legLength && split.legLength > 0 && split.splitTime > 0)
          ? formatPace(split.legLength, split.splitTime).padStart(5)
          : "    -";
        b.line(`${idx} ${code} ${splitFmt} ${clockFmt} ${cumFmt} ${pace}`);
      }
    }

    // Mal row — last leg split + finish clock + total time + pace
    const lastSplit = data.splits[data.splits.length - 1];
    const malSplitDs = (lastSplit && lastSplit.status !== "missing") ? lastSplit.splitTime : 0;
    const malSplitFmt = malSplitDs > 0 ? formatRunningTime(malSplitDs).padStart(6) : "      ";
    const malClock = finishTime > 0 ? formatClock(finishTime) : "        ";
    const malCum = formatRunningTime(runningTime).padStart(6);
    const malPace = (lastSplit && lastSplit.legLength && lastSplit.legLength > 0 && malSplitDs > 0)
      ? formatPace(lastSplit.legLength, malSplitDs).padStart(5)
      : "    -";
    b.boldOn().line(`Mal  ${malSplitFmt} ${malClock} ${malCum} ${malPace}`).boldOff();
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
    b.line(`  Batteri: ${voltStr}   ${dateStr}   ${okStr}`);
    b.separator();
  }

  // ── Position + class results ─────────────────────────────────
  if (data.position) {
    const posLabel = `${data.position.rank}/${data.position.total}`;
    b.boldOn().line(`  Placering: ${posLabel}`).boldOff();
  }
  if (data.classResults && data.classResults.length > 0) {
    for (const r of data.classResults) {
      const timeFmt = formatRunningTime(r.runningTime);
      const clubShort = r.clubName.length > 10 ? r.clubName.slice(0, 9) + "." : r.clubName;
      const nameClub = `  ${r.rank}  ${r.name} (${clubShort})`;
      b.leftRight(nameClub, `${timeFmt}  `);
    }
    b.separator();
  }

  // ── Footer ───────────────────────────────────────────────────
  b.alignCenter();
  b.centered("Results by: Oxygen - Open Orienteering");
  const now = new Date();
  const timestamp = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  b.centered(timestamp);
  b.lf();

  // ── Cut ──────────────────────────────────────────────────────
  b.cut();

  return b.build();
}
