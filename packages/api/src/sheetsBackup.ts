import type { PrismaClient } from "@prisma/client";
import { ensureCompetitionConfigTable } from "./db.js";

export interface SheetRow {
  sheet?: string;
  timestamp: string;
  cardNo: number;
  cardType: string;
  runnerName: string;
  className: string;
  clubName: string;
  startNo: number;
  checkTime: number | null;
  startTime: number | null;
  finishTime: number | null;
  punchCount: number;
  punches: string;
  punchesRelevant: boolean;
  batteryVoltage: number | null;
}

export interface RegistrationRow {
  sheet: string;
  timestamp: string;
  runnerId: number;
  name: string;
  className: string;
  clubName: string;
  cardNo: number;
  startNo: number;
  birthYear: number;
  sex: string;
  nationality: string;
  phone: string;
  fee: number;
  paid: number;
  payMode: number;
}

let cachedWebhookUrl: string | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60_000;

async function getWebhookUrl(client: PrismaClient): Promise<string> {
  if (cachedWebhookUrl !== null && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cachedWebhookUrl;
  }
  try {
    await ensureCompetitionConfigTable(client);
    const rows = await client.$queryRawUnsafe<
      Array<{ google_sheets_webhook_url: string }>
    >(
      "SELECT google_sheets_webhook_url FROM oxygen_competition_config WHERE id = 1",
    );
    cachedWebhookUrl = rows[0]?.google_sheets_webhook_url ?? "";
  } catch {
    cachedWebhookUrl = "";
  }
  cacheTime = Date.now();
  return cachedWebhookUrl;
}

export function clearSheetsCache(): void {
  cachedWebhookUrl = null;
  cacheTime = 0;
}

/** Fire-and-forget POST to the configured webhook. */
function fireAndForget(client: PrismaClient, payload: Record<string, unknown>): void {
  void (async () => {
    const url = await getWebhookUrl(client);
    if (!url) return;

    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[sheetsBackup] Push failed:", msg);
    }
  })();
}

/**
 * Fire-and-forget push of a card readout row to the "Readouts" sheet.
 */
export function pushToGoogleSheet(
  client: PrismaClient,
  row: SheetRow,
): void {
  fireAndForget(client, { ...row, sheet: "Readouts" });
}

/**
 * Fire-and-forget push of a registration row to the "Registrations" sheet.
 */
export function pushRegistrationToSheet(
  client: PrismaClient,
  row: RegistrationRow,
): void {
  fireAndForget(client, { ...row, sheet: "Registrations" });
}

/**
 * Send a test row to verify the webhook URL works. Returns the response status.
 */
export async function testGoogleSheetPush(url: string): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const now = new Date().toISOString();

    // Test readout sheet
    const res1 = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sheet: "Readouts",
        timestamp: now,
        cardNo: 0,
        cardType: "TEST",
        runnerName: "Test Connection",
        className: "",
        clubName: "",
        startNo: 0,
        checkTime: null,
        startTime: null,
        finishTime: null,
        punchCount: 0,
        punches: "",
        punchesRelevant: true,
        batteryVoltage: null,
      } satisfies SheetRow),
    });
    if (!res1.ok) return { ok: false, status: res1.status };

    // Test registration sheet
    const res2 = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sheet: "Registrations",
        timestamp: now,
        runnerId: 0,
        name: "Test Connection",
        className: "",
        clubName: "",
        cardNo: 0,
        startNo: 0,
        birthYear: 0,
        sex: "",
        nationality: "",
        phone: "",
        fee: 0,
        paid: 0,
        payMode: 0,
      } satisfies RegistrationRow),
    });
    return { ok: res2.ok, status: res2.status };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, error: msg };
  }
}
