/**
 * Star raster receipt encoder for the TSP100 family.
 *
 * Renders Oxygen receipts as 1-bit bitmaps via off-screen Canvas and wraps
 * them in Star's raster command set. Used for TSP100 / TSP100ECO /
 * TSP100GT / TSP143 USB printers, which are raster-only on their default
 * firmware (no ESC/POS support).
 *
 * Wire format (verified against Star CUPS driver source `rastertostar.c`):
 *
 *   1B 40                          ESC @                    init
 *   1B 2A 72 52 1B 2A 72 41        ESC *rR ESC *rA          enter raster mode
 *   1B 2A 72 45 31 33 00           ESC *rE13                docCutType partial
 *   [per scan line]
 *     blank streak: 1B 2A 72 59 <ASCII count> 00            ESC *rY<n>
 *     data line:    62 <len_lo> <len_hi> <bytes…>           'b' <len> <data>
 *   1B 2A 72 59 31 00 1B 0C        ESC *rY1 ESC FF          endPage (cuts)
 *   04 1B 2A 72 42                 EOT ESC *rB              endJob
 *
 * Paper-economy note: the cut command is a configuration sent up-front
 * ("when end-of-page happens, do this kind of cut"). The actual cut
 * triggers on the form-feed at endPage. Sending the cut command after the
 * data without a form-feed makes the printer waste ~10 cm of paper before
 * cutting.
 */

import { formatMeosTime, formatRunningTime, runnerStatusLabel } from "@oxygen/shared";
import type { RunnerStatusValue } from "@oxygen/shared";
import QRCode from "qrcode";
import type {
  FinishReceiptData,
  RegistrationReceiptData,
  FinishReceiptLabels,
  RegistrationReceiptLabels,
} from "./types.js";

// ─── Constants ───────────────────────────────────────────────

/** TSP100 print width in dots (= 72 bytes per scan line at 8 dots/byte). */
export const STAR_RASTER_WIDTH_DOTS = 576;
const STAR_RASTER_WIDTH_BYTES = STAR_RASTER_WIDTH_DOTS / 8;

/** Maximum receipt height (~50 cm at 203 dpi). Safety cap. */
const MAX_HEIGHT_DOTS = 4096;

/** Layout cell sizes — picked so a 42-char monospace layout fits within 576 dots. */
const LINE_HEIGHT_NORMAL = 24;
const LINE_HEIGHT_DOUBLE = 44;
const FONT_FAMILY = '"Courier New", "DejaVu Sans Mono", "Liberation Mono", monospace';
const FONT_NORMAL = `18px ${FONT_FAMILY}`;
const FONT_BOLD = `bold 18px ${FONT_FAMILY}`;
const FONT_DOUBLE = `bold 32px ${FONT_FAMILY}`;

/** Default labels copied from escpos.ts so the two paths produce equivalent text. */
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

// ─── Pure encoder ────────────────────────────────────────────

export interface StarRasterBitmap {
  widthBytes: number;
  heightDots: number;
  /** widthBytes × heightDots bytes, MSB-first within each byte (1 = black). */
  data: Uint8Array;
}

export type StarRasterCutType = "partial" | "full" | "none";

/**
 * Encode a 1-bit bitmap as Star raster command bytes ready to send to the
 * printer's bulk OUT endpoint. Pure function — no DOM/Canvas required.
 *
 * The cut type is sent as a configuration before any data, with the
 * actual cut triggered by the endPage form-feed at the end of the bytes.
 */
export function encodeBitmapAsStarRaster(
  bitmap: StarRasterBitmap,
  options: { cut?: StarRasterCutType } = {},
): Uint8Array {
  const cut: StarRasterCutType = options.cut ?? "partial";

  if (bitmap.widthBytes <= 0) {
    throw new Error(`bitmap widthBytes must be positive, got ${bitmap.widthBytes}`);
  }
  if (bitmap.widthBytes > STAR_RASTER_WIDTH_BYTES) {
    throw new Error(
      `bitmap widthBytes ${bitmap.widthBytes} exceeds TSP100 max of ${STAR_RASTER_WIDTH_BYTES} bytes`,
    );
  }
  if (bitmap.data.length !== bitmap.widthBytes * bitmap.heightDots) {
    throw new Error(
      `bitmap data length ${bitmap.data.length} does not match widthBytes×heightDots = ${bitmap.widthBytes * bitmap.heightDots}`,
    );
  }

  const out: number[] = [];

  // ── Prologue ──────────────────────────────────────────
  // ESC @
  out.push(0x1b, 0x40);
  // ESC *rR ESC *rA — enter raster mode
  out.push(0x1b, 0x2a, 0x72, 0x52, 0x1b, 0x2a, 0x72, 0x41);
  // docCutType: partial (E13), full (E9), or omitted
  if (cut === "partial") {
    out.push(0x1b, 0x2a, 0x72, 0x45, 0x31, 0x33, 0x00);
  } else if (cut === "full") {
    out.push(0x1b, 0x2a, 0x72, 0x45, 0x39, 0x00);
  }

  // ── Scan lines ────────────────────────────────────────
  // Defer blank rows; emit ESC *rY<n> 00 just before the next data row.
  // (Trailing blanks at the bottom are dropped — endPage form-feed handles
  // the cutter offset, no need to advance past them.)
  let blankCount = 0;
  for (let row = 0; row < bitmap.heightDots; row++) {
    const rowStart = row * bitmap.widthBytes;
    let lastNonZero = -1;
    for (let b = bitmap.widthBytes - 1; b >= 0; b--) {
      if (bitmap.data[rowStart + b] !== 0) {
        lastNonZero = b;
        break;
      }
    }
    if (lastNonZero < 0) {
      blankCount++;
      continue;
    }
    if (blankCount > 0) {
      out.push(0x1b, 0x2a, 0x72, 0x59);
      const ascii = String(blankCount);
      for (let i = 0; i < ascii.length; i++) out.push(ascii.charCodeAt(i));
      out.push(0x00);
      blankCount = 0;
    }
    const len = lastNonZero + 1;
    out.push(0x62, len & 0xff, (len >> 8) & 0xff);
    for (let b = 0; b < len; b++) {
      out.push(bitmap.data[rowStart + b]!);
    }
  }

  // ── Epilogue ──────────────────────────────────────────
  // endPage: ESC *rY 1 00 ESC FF — form-feed triggers the configured cut
  out.push(0x1b, 0x2a, 0x72, 0x59, 0x31, 0x00, 0x1b, 0x0c);
  // endJob: EOT ESC *rB
  out.push(0x04, 0x1b, 0x2a, 0x72, 0x42);

  return new Uint8Array(out);
}

// ─── Canvas builder ──────────────────────────────────────────

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function createCanvas(width: number, height: number): { canvas: AnyCanvas; ctx: AnyCtx } {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
    return { canvas, ctx };
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    return { canvas, ctx };
  }
  throw new Error("No Canvas API available (Star raster requires a browser environment)");
}

/**
 * Mirrors EscPosBuilder enough to render the same receipt structure, but
 * draws to an off-screen canvas rather than emitting ESC/POS bytes.
 * Call build() to get the final raster command bytes.
 */
class StarRasterReceiptBuilder {
  private canvas: AnyCanvas;
  private ctx: AnyCtx;
  private y = 0;
  private align: "left" | "center" = "left";
  private bold = false;
  private double = false;

  constructor() {
    const { canvas, ctx } = createCanvas(STAR_RASTER_WIDTH_DOTS, MAX_HEIGHT_DOTS);
    this.canvas = canvas;
    this.ctx = ctx;
    // White background, black ink.
    this.ctx.fillStyle = "white";
    this.ctx.fillRect(0, 0, STAR_RASTER_WIDTH_DOTS, MAX_HEIGHT_DOTS);
    this.ctx.fillStyle = "black";
    this.ctx.textBaseline = "top";
    this.applyFont();
  }

  private applyFont(): void {
    if (this.double) this.ctx.font = FONT_DOUBLE;
    else if (this.bold) this.ctx.font = FONT_BOLD;
    else this.ctx.font = FONT_NORMAL;
  }

  private currentLineHeight(): number {
    return this.double ? LINE_HEIGHT_DOUBLE : LINE_HEIGHT_NORMAL;
  }

  // ── Builder methods (no-op on canvas, kept for API parity) ──
  init(): this { return this; }
  lf(): this { this.y += LINE_HEIGHT_NORMAL; return this; }
  feedDots(n: number): this { this.y += n; return this; }
  alignLeft(): this { this.align = "left"; return this; }
  alignCenter(): this { this.align = "center"; return this; }
  boldOn(): this { this.bold = true; this.applyFont(); return this; }
  boldOff(): this { this.bold = false; this.applyFont(); return this; }
  sizeDouble(): this { this.double = true; this.applyFont(); return this; }
  sizeNormal(): this { this.double = false; this.applyFont(); return this; }

  /** Draw a single line of text and advance y by the current line height. */
  line(s: string): this {
    let x = 0;
    if (this.align === "center") {
      const w = this.ctx.measureText(s).width;
      x = Math.max(0, Math.round((STAR_RASTER_WIDTH_DOTS - w) / 2));
    }
    this.ctx.fillText(s, x, this.y);
    this.y += this.currentLineHeight();
    return this;
  }

  /** Print left and right strings on one line, with the right side at the right margin. */
  leftRight(left: string, right: string): this {
    this.ctx.fillText(left, 0, this.y);
    const rightW = this.ctx.measureText(right).width;
    this.ctx.fillText(right, Math.max(0, STAR_RASTER_WIDTH_DOTS - rightW), this.y);
    this.y += this.currentLineHeight();
    return this;
  }

  /** Horizontal rule — equivalent to the `===` line in escpos.ts. */
  separator(): this {
    this.y += 4;
    this.ctx.fillRect(0, this.y, STAR_RASTER_WIDTH_DOTS, 2);
    this.y += 8;
    return this;
  }

  /**
   * Draw a QR code centered on the canvas.
   *
   * `text` is the payload (typically a URL). `moduleSize` is the size in
   * dots of one QR module — 5 dots ≈ 18 mm at 203 dpi for a typical URL,
   * which matches the ESC/POS path's default `qrCode(text, 5)`.
   */
  qrCode(text: string, moduleSize = 5): this {
    const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
    const size = qr.modules.size;
    const data = qr.modules.data;
    const widthDots = size * moduleSize;
    const x0 = Math.max(0, Math.round((STAR_RASTER_WIDTH_DOTS - widthDots) / 2));
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (data[row * size + col]) {
          this.ctx.fillRect(x0 + col * moduleSize, this.y + row * moduleSize, moduleSize, moduleSize);
        }
      }
    }
    this.y += widthDots;
    return this;
  }

  /** Embed an existing 1-bit raster (logo) by stamping it onto the canvas centered. */
  rasterImage(widthBytes: number, heightDots: number, data: Uint8Array): this {
    const widthDots = widthBytes * 8;
    const imgData = this.ctx.createImageData(widthDots, heightDots);
    for (let row = 0; row < heightDots; row++) {
      for (let col = 0; col < widthDots; col++) {
        const byteIdx = row * widthBytes + (col >> 3);
        const bitMask = 1 << (7 - (col & 7));
        const black = (data[byteIdx]! & bitMask) !== 0;
        const i = (row * widthDots + col) * 4;
        const v = black ? 0 : 255;
        imgData.data[i] = v;
        imgData.data[i + 1] = v;
        imgData.data[i + 2] = v;
        imgData.data[i + 3] = 255;
      }
    }
    const x = Math.max(0, Math.round((STAR_RASTER_WIDTH_DOTS - widthDots) / 2));
    this.ctx.putImageData(imgData, x, this.y);
    this.y += heightDots;
    return this;
  }

  // ── Bordered "kvitto box" used in registration receipts ──
  // Simplified for canvas: draw a rectangular border around a content
  // area. Track the box state so multiple boxLine() calls keep adding to
  // the same box.
  private boxStartY: number | null = null;
  boxTop(): this {
    this.boxStartY = this.y;
    this.y += 4;
    return this;
  }
  boxLine(s: string): this {
    const x = 16;
    this.ctx.fillText(s, x, this.y + 2);
    this.y += this.currentLineHeight();
    return this;
  }
  boxLineDouble(s: string): this {
    this.sizeDouble();
    const w = this.ctx.measureText(s).width;
    const x = Math.max(16, Math.round((STAR_RASTER_WIDTH_DOTS - w) / 2));
    this.ctx.fillText(s, x, this.y);
    this.y += LINE_HEIGHT_DOUBLE;
    this.sizeNormal();
    return this;
  }
  boxBottom(): this {
    if (this.boxStartY != null) {
      this.y += 4;
      const top = this.boxStartY;
      const bottom = this.y;
      this.ctx.fillRect(0, top, STAR_RASTER_WIDTH_DOTS, 2);
      this.ctx.fillRect(0, bottom, STAR_RASTER_WIDTH_DOTS, 2);
      this.ctx.fillRect(0, top, 2, bottom - top);
      this.ctx.fillRect(STAR_RASTER_WIDTH_DOTS - 2, top, 2, bottom - top);
      this.boxStartY = null;
      this.y += 6;
    }
    return this;
  }

  // No-ops in canvas mode (line spacing is implicit from currentLineHeight).
  setLineSpacing(_n: number): this { return this; }
  resetLineSpacing(): this { return this; }

  /**
   * Threshold the canvas content down to a 1-bit MSB-first bitmap and emit
   * the full Star raster command sequence around it.
   */
  build(cut: StarRasterCutType = "partial"): Uint8Array {
    const usedHeight = Math.min(this.y, MAX_HEIGHT_DOTS);
    if (usedHeight <= 0) {
      // Empty receipt — still emit the prologue/epilogue so the printer
      // doesn't sit confused.
      return encodeBitmapAsStarRaster(
        { widthBytes: STAR_RASTER_WIDTH_BYTES, heightDots: 0, data: new Uint8Array(0) },
        { cut },
      );
    }

    const px = this.ctx.getImageData(0, 0, STAR_RASTER_WIDTH_DOTS, usedHeight).data;
    const bitmap = new Uint8Array(STAR_RASTER_WIDTH_BYTES * usedHeight);
    for (let row = 0; row < usedHeight; row++) {
      for (let col = 0; col < STAR_RASTER_WIDTH_DOTS; col++) {
        const i = (row * STAR_RASTER_WIDTH_DOTS + col) * 4;
        const r = px[i]!;
        const g = px[i + 1]!;
        const b = px[i + 2]!;
        const a = px[i + 3]!;
        const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
        if (a >= 128 && luminance < 128) {
          bitmap[row * STAR_RASTER_WIDTH_BYTES + (col >> 3)]! |= 1 << (7 - (col & 7));
        }
      }
    }

    return encodeBitmapAsStarRaster(
      { widthBytes: STAR_RASTER_WIDTH_BYTES, heightDots: usedHeight, data: bitmap },
      { cut },
    );
  }
}

// ─── Layout helpers (mirrored from escpos.ts) ───────────────

const LINE_WIDTH = 42;

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

function formatClock(ds: number): string {
  if (ds <= 0) return "        ";
  const totalSec = Math.floor(ds / 10);
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function formatPace(legLength: number, splitDs: number): string {
  if (!legLength || !splitDs || splitDs <= 0) return "";
  const minPerKm = splitDs / (legLength * 0.6);
  if (minPerKm > 99) return "";
  const mins = Math.floor(minPerKm);
  let secs = Math.round((minPerKm - mins) * 60);
  let adjustedMins = mins;
  if (secs >= 60) { secs -= 60; adjustedMins += 1; }
  return `${adjustedMins}:${String(secs).padStart(2, "0")}`;
}

function formatAmountSEK(amount: number): string {
  return `${amount},00 kr`;
}

// ─── Public receipt builders ────────────────────────────────

/**
 * Build a finish receipt as Star raster command bytes.
 *
 * Canvas-based; only callable in a browser context (or any environment
 * with HTMLCanvasElement / OffscreenCanvas available).
 */
export function buildFinishReceiptStarRaster(data: FinishReceiptData): Uint8Array {
  const L = { ...DEFAULT_FINISH_LABELS, ...data.labels };
  const b = new StarRasterReceiptBuilder();

  b.init();
  b.lf();

  // ── Logo ──────────────────────────────────────────────
  if (data.logoRaster) {
    b.alignCenter();
    b.rasterImage(data.logoRaster.widthBytes, data.logoRaster.heightDots, data.logoRaster.data);
    b.lf();
    b.alignLeft();
  }

  // ── Header ─────────────────────────────────────────────
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

  // ── Runner info ────────────────────────────────────────
  b.boldOn().line(`  ${data.runner.name}  ${data.runner.className}`).boldOff();
  if (data.runner.clubName) b.line(`  ${data.runner.clubName}`);
  b.separator();

  // ── Status line ────────────────────────────────────────
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

  // ── Splits ─────────────────────────────────────────────
  if (data.splits.length > 0) {
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

  // ── SIAC battery ───────────────────────────────────────
  if (data.siac) {
    const cardNo = data.runner.cardNo ?? 0;
    if (cardNo > 0) b.line(`  SIAC ${cardNo}`);
    const voltStr = data.siac.voltage != null ? `${data.siac.voltage.toFixed(2)}V` : "-.--V";
    const dateStr = data.siac.batteryDate ?? "";
    const okStr = data.siac.batteryOk ? "OK" : "LOW";
    b.line(`  ${L.battery}: ${voltStr}   ${dateStr}   ${okStr}`);
    b.separator();
  }

  // ── Position + class results ───────────────────────────
  if (data.position) {
    const posLabel = `${data.position.rank}/${data.position.total}`;
    b.boldOn().line(`  ${L.position}: ${posLabel}`).boldOff();
  }
  if (data.classResults && data.classResults.length > 0) {
    for (const r of data.classResults) {
      const timeFmt = formatRunningTime(r.runningTime);
      const right = `${timeFmt}  `;
      const maxLeft = LINE_WIDTH - right.length - 1;
      const prefix = `  ${r.rank}  `;
      const clubShort = r.clubName.length > 10 ? r.clubName.slice(0, 9) + "." : r.clubName;
      const withClub = `${prefix}${r.name} (${clubShort})`;
      const withoutClub = `${prefix}${r.name}`;
      let left: string;
      if (withClub.length <= maxLeft) left = withClub;
      else if (withoutClub.length <= maxLeft) left = withoutClub;
      else left = withoutClub.slice(0, maxLeft);
      b.leftRight(left, right);
    }
    b.separator();
  }

  // ── Custom message ────────────────────────────────────
  if (data.customMessage) {
    b.alignCenter();
    for (const line of wordWrap(data.customMessage, LINE_WIDTH)) b.line(line);
    b.alignLeft();
    b.separator();
  }

  // ── QR code ───────────────────────────────────────────
  // Generate the QR matrix client-side via the `qrcode` package and
  // rasterize directly onto our canvas (Star raster has no native QR
  // support, unlike ESC/POS GS ( k).
  if (data.qrUrl) {
    b.alignCenter();
    b.line(L.competitionInfo);
    b.feedDots(4);
    b.qrCode(data.qrUrl, 5);
    b.lf();
    b.alignLeft();
  }

  // ── Footer ────────────────────────────────────────────
  b.alignCenter();
  b.boldOn().line("Oxygen").boldOff();
  b.line(L.tagline);
  b.line("open-orienteering.org");
  const now = new Date();
  const timestamp = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  b.line(timestamp);
  b.lf();

  return b.build("partial");
}

/** Build a registration receipt as Star raster command bytes. */
export function buildRegistrationReceiptStarRaster(data: RegistrationReceiptData): Uint8Array {
  const L = { ...DEFAULT_REG_LABELS, ...data.labels };
  const b = new StarRasterReceiptBuilder();
  b.init();
  b.lf();

  const kvittoMode = !!data.orgNumber;

  // ── Logo ──────────────────────────────────────────────
  if (data.logoRaster) {
    b.alignCenter();
    b.rasterImage(data.logoRaster.widthBytes, data.logoRaster.heightDots, data.logoRaster.data);
    b.lf();
    b.alignLeft();
  }

  // ── Header ────────────────────────────────────────────
  b.alignCenter();
  for (const nameLine of wordWrap(data.competitionName, Math.floor(LINE_WIDTH / 2))) {
    b.sizeDouble().boldOn().line(nameLine).boldOff().sizeNormal();
  }
  if (data.competitionDate) {
    b.feedDots(8);
    b.line(data.competitionDate);
  }
  b.alignLeft();

  // ── Organizer details (kvitto mode) ──────────────────
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

  // ── Title ─────────────────────────────────────────────
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
  const now = new Date();
  const dateTimeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  b.line(dateTimeStr);
  b.alignLeft();
  b.lf();
  b.separator();

  // ── Runner info ───────────────────────────────────────
  b.lf();
  b.leftRight(L.participant, data.runner.name);
  if (data.runner.clubName) b.leftRight(L.club, data.runner.clubName);
  b.leftRight(L.class, data.runner.className);
  b.leftRight(L.siCard, String(data.runner.cardNo));
  b.leftRight(L.start, data.startTime || L.freeStart);
  b.lf();

  // ── Financial section ─────────────────────────────────
  if (kvittoMode && data.payment) {
    b.separator();
    b.lf();
    const entryFeeAmount = data.payment.amount - (data.payment.cardFee ?? 0);
    b.leftRight(L.entryFee, formatAmountSEK(entryFeeAmount));
    if (data.payment.cardFee) {
      b.leftRight(L.rentalCardFee, formatAmountSEK(data.payment.cardFee));
    }
    const vatExempt = data.vatInfo?.exempt ?? true;
    if (vatExempt) b.line(`${L.vat}: 0,00 kr (${L.vatExempt})`);
    b.lf();
    b.separator();

    // Payment box
    b.alignCenter();
    b.boxTop();
    b.boxLine("");
    b.boxLineDouble(`${L.amount.replace(/:$/, "")}  ${formatAmountSEK(data.payment.amount)}`);
    b.boxLine("");
    b.boxLine(`${L.paymentMethod} ${data.payment.method}`);
    b.boxBottom();
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

  // ── Friskvardsbidrag note ─────────────────────────────
  if (kvittoMode && data.friskvardNote) {
    b.lf();
    b.alignCenter();
    b.line(L.friskvardNote);
    b.alignLeft();
  }

  // ── Custom message ────────────────────────────────────
  if (data.customMessage) {
    b.lf();
    b.alignCenter();
    for (const line of wordWrap(data.customMessage, LINE_WIDTH)) b.line(line);
    b.alignLeft();
  }

  // ── Footer ────────────────────────────────────────────
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

  return b.build("partial");
}

/**
 * Build a small known test pattern (a 1-row-thick black bar) wrapped in the
 * full Star raster sequence. Used by the Printer Settings dialog as a Star
 * equivalent of the ESC/POS self-test.
 */
export function buildStarRasterTestPattern(): Uint8Array {
  // 9 bytes wide × 1 dot tall — same pattern as our verified hand-test.
  const data = new Uint8Array(9).fill(0xff);
  return encodeBitmapAsStarRaster(
    { widthBytes: 9, heightDots: 1, data },
    { cut: "partial" },
  );
}
