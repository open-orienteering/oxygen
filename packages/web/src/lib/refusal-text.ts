import { isJournalRefusalCode } from "@oxygen/shared";
import type { TFunction } from "i18next";

/** The text for a refused entry: a known code is translated, anything else (an older server) shows as sent. */
export function refusalText(
  t: TFunction<"common">,
  error: string,
  capability?: string,
): string {
  if (!isJournalRefusalCode(error)) return error;
  if (error === "FORBIDDEN") {
    const role = capability ? t(`capabilityRole.${capability}` as "retry", { defaultValue: capability }) : "";
    return role ? t("refusal.FORBIDDEN", { role }) : t("refusal.FORBIDDEN_unknown");
  }
  return t(`refusal.${error}`);
}
