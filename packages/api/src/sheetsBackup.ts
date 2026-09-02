import type { PrismaClient } from "./generated/prisma/client.js";

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

const webhookCache = new Map<string, { url: string; at: number }>();
const CACHE_TTL_MS = 60_000;

/**
 * The webhook URL for one event. Cached per event so two competitions
 * on the same process cannot send each other's readouts.
 */
export async function getWebhookUrl(
  client: PrismaClient,
  eventId: bigint,
): Promise<string> {
  const key = String(eventId);
  const hit = webhookCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.url;

  let url = "";
  try {
    const row = await client.event.findUnique({
      where: { id: eventId },
      select: { googleSheetsWebhookUrl: true },
    });
    url = row?.googleSheetsWebhookUrl ?? "";
  } catch {
    url = "";
  }
  webhookCache.set(key, { url, at: Date.now() });
  return url;
}

export function clearSheetsCache(): void {
  webhookCache.clear();
}

/** Fire-and-forget POST to the configured webhook. */
function fireAndForget(client: PrismaClient, eventId: bigint, payload: Record<string, unknown>): void {
  void (async () => {
    const url = await getWebhookUrl(client, eventId);
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
  eventId: bigint,
  row: SheetRow,
): void {
  fireAndForget(client, eventId, { ...row, sheet: "Readouts" });
}

/**
 * Fire-and-forget push of a registration row to the "Registrations" sheet.
 */
export function pushRegistrationToSheet(
  client: PrismaClient,
  eventId: bigint,
  row: RegistrationRow,
): void {
  fireAndForget(client, eventId, { ...row, sheet: "Registrations" });
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
