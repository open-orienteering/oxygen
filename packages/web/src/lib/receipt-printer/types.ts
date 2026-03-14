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

/** Translatable label strings for the finish receipt. All have English defaults in escpos.ts. */
export interface FinishReceiptLabels {
  start?: string;
  finish?: string;
  splitHeader?: string;
  fin?: string;
  battery?: string;
  position?: string;
  competitionInfo?: string;
  tagline?: string;
  missing?: string;
}

/** Translatable label strings for the registration receipt. All have English defaults in escpos.ts. */
export interface RegistrationReceiptLabels {
  registration?: string;
  receipt?: string;
  name?: string;
  club?: string;
  class?: string;
  siCard?: string;
  start?: string;
  freeStart?: string;
  payment?: string;
  amount?: string;
  printed?: string;
  tagline?: string;
  entryFee?: string;
  vatExempt?: string;
  vat?: string;
  total?: string;
  friskvardNote?: string;
  date?: string;
  participant?: string;
  entryFeeSubtitle?: string;
  paymentMethod?: string;
  rentalCardFee?: string;
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
  /** Translated labels for receipt strings. English defaults used when omitted. */
  labels?: FinishReceiptLabels;
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
    amount: number; // total amount (entry fee + card fee)
    cardFee?: number; // rental card portion, printed as a separate line if > 0
  };
  logoRaster?: LogoRaster | null;
  /** Optional custom message to print on the receipt. */
  customMessage?: string;
  /** Organizer/club name to display on kvitto header. */
  organizerName?: string;
  /** Full organizer details from Eventor (address, phone, email). */
  organizerDetails?: {
    name: string;
    street?: string;
    city?: string;
    zip?: string;
    phone?: string;
    email?: string;
    webUrl?: string;
  };
  /** Organization number for friskvardsbidrag (e.g., "802407-2996"). */
  orgNumber?: string;
  /** VAT information. */
  vatInfo?: { exempt: boolean };
  /** Whether to print the friskvardsbidrag eligibility note. */
  friskvardNote?: boolean;
  /** Translated labels for receipt strings. English defaults used when omitted. */
  labels?: RegistrationReceiptLabels;
}
