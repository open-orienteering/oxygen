/**
 * Receipt printer abstraction layer.
 *
 * PrinterDriver is transport-agnostic — implement it for new printer types:
 *   - WebUSB (current, see drivers/webusb.ts)
 *   - Web Serial (for USB-serial printers)
 *   - Network/TCP (for WiFi printers)
 *   - Backend API (for cloud deployments with a local printer agent)
 */

/** Transport-agnostic printer driver interface. */
export interface PrinterDriver {
  readonly name: string;
  readonly connected: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendBytes(data: Uint8Array): Promise<void>;
}

/** One control split entry on the finish receipt. */
export interface FinishReceiptSplit {
  controlIndex: number; // 0-based sequence number on the course
  controlCode: number;
  splitTime: number; // deciseconds from previous control (or start)
  cumTime: number; // deciseconds from start
  status: "ok" | "missing" | "extra";
  punchTime?: number; // deciseconds since midnight (clock time of punch)
  legLength?: number; // metres for this leg (for pace calculation)
}

/** Pre-rasterized 1-bit logo image for printing via ESC/POS GS v 0. */
export interface LogoRaster {
  widthBytes: number;    // ceil(widthDots / 8)
  heightDots: number;
  data: Uint8Array;      // widthBytes × heightDots bytes, MSB-first, 1=black
}

/** All data needed to format and print a finish receipt. */
export interface FinishReceiptData {
  competitionName: string;
  competitionDate?: string; // "YYYY-MM-DD"
  runner: {
    name: string;
    clubName: string;
    className: string;
    startNo: number;
    cardNo?: number;
  };
  timing: {
    startTime: number; // deciseconds since midnight
    finishTime: number; // deciseconds since midnight
    runningTime: number; // deciseconds
    status: number; // RunnerStatus value
  };
  splits: FinishReceiptSplit[];
  course: { name: string; length: number } | null;
  position: { rank: number; total: number } | null;
  /** SIAC/SI card battery info from the most recent readout. Null if unavailable. */
  siac?: {
    voltage: number | null;
    batteryDate: string | null;
    batteryOk: boolean;
  } | null;
  /** Top finishers in the same class (for Resultat section). */
  classResults?: Array<{
    rank: number;
    name: string;
    clubName: string;
    runningTime: number;
  }>;
  /** Pre-rasterized organizing club logo. Null = no logo printed. */
  logoRaster?: LogoRaster | null;
  /** URL to encode as a QR code at the bottom. Null = no QR printed. */
  qrUrl?: string | null;
  /** Optional custom message to print on the receipt. */
  customMessage?: string;
}

/** All data needed to format and print a registration receipt. */
export interface RegistrationReceiptData {
  competitionName: string;
  competitionDate?: string;
  runner: {
    name: string;
    clubName: string;
    className: string;
    cardNo: number;
  };
  startTime?: string; // formatted HH:MM:SS or undefined for free start
  payment?: {
    method: string; // "Invoice", "Card", "Swish", "Pay on site"
    amount: number; // whole currency units (e.g., 50 = 50 SEK)
  };
  logoRaster?: LogoRaster | null;
  /** Optional custom message to print on the receipt. */
  customMessage?: string;
}
