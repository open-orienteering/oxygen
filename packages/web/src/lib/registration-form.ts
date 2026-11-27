import type { TFunction } from "i18next";
import { isNetworkFailure } from "./trpc-links";

/**
 * Pure helpers of the registration dialog (WEB-19, WEB-22). Kept apart from
 * the component so the rules are unit-tested.
 */

export type PaymentMode = "billed" | "on-site" | "card" | "swish" | "cash" | "";

const PAYMENT_MODES: readonly PaymentMode[] = ["billed", "on-site", "card", "swish", "cash"];

/**
 * The payment method a fresh form starts with: the first method the event
 * offers (the organiser orders them in the settings), or none. Every reset
 * path uses this one rule; earlier, a clear preferred "billed" while the
 * first open took the first method (WEB-19).
 */
export function defaultPaymentMode(config: { paymentMethods?: readonly string[] } | null | undefined): PaymentMode {
  const first = config?.paymentMethods?.[0];
  return first && (PAYMENT_MODES as readonly string[]).includes(first) ? (first as PaymentMode) : "";
}

/**
 * The text shown for a failed online registration (WEB-22). The server's
 * own codes become an action the operator can take; the raw error goes to
 * the console.
 */
export function registrationErrorMessage(err: unknown, t: TFunction<"registration">): string {
  const message = err instanceof Error ? err.message : String((err as { message?: unknown } | null)?.message ?? "");
  // A start on the zero time is refused with its own message (RES-04).
  if (message.startsWith("ZERO_TIME_COLLISION")) return message.replace(/^[A-Z_]+: /, "");
  const code = (err as { data?: { code?: unknown } | null } | null)?.data?.code;
  if (code === "CONFLICT") return t("errorCardTaken");
  if (code === "FORBIDDEN" || code === "UNAUTHORIZED") return t("errorForbidden");
  if (code === "NOT_FOUND") return t("errorNotFound");
  if (code === "PRECONDITION_FAILED") return message || t("registrationFailed");
  if (isNetworkFailure(err)) return t("errorUnreachable");
  return t("registrationFailed");
}
