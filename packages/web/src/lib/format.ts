/**
 * Shared date / time formatting utilities.
 *
 * Convention throughout the project:
 *   Date     → YYYY-MM-DD            (ISO 8601 date)
 *   DateTime → YYYY-MM-DD HH:mm:ss   (24h, no T separator)
 *   Relative → "just now", "5 min ago", "2 hours ago", "3 days ago", …
 *
 * The built-in MeOS time helpers (formatMeosTime, formatRunningTime) live in
 * packages/shared/src/types.ts since they're used by both API and web.
 */

/** Format a JS Date (or ISO string) as "YYYY-MM-DD HH:mm:ss" */
export function formatDateTime(input: Date | string | number): string {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return String(input);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** Format a JS Date (or ISO string) as "YYYY-MM-DD" */
export function formatDate(input: Date | string | number): string {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return String(input);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Compute the numeric diff bucket for a date, returning the key + count.
 * Used by timeAgo (English fallback) and useTimeAgo (i18n-aware).
 */
export function timeAgoParts(input: Date | string | number): { key: string; count: number } {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return { key: "", count: 0 };
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return { key: "justNow", count: 0 };

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return { key: "justNow", count: 0 };

  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return { key: "minuteAgo", count: 1 };
  if (minutes < 60) return { key: "minutesAgo", count: minutes };

  const hours = Math.floor(minutes / 60);
  if (hours === 1) return { key: "hourAgo", count: 1 };
  if (hours < 24) return { key: "hoursAgo", count: hours };

  const days = Math.floor(hours / 24);
  if (days === 1) return { key: "dayAgo", count: 1 };
  if (days < 30) return { key: "daysAgo", count: days };

  const months = Math.floor(days / 30);
  if (months === 1) return { key: "monthAgo", count: 1 };
  if (months < 12) return { key: "monthsAgo", count: months };

  const years = Math.floor(days / 365);
  if (years === 1) return { key: "yearAgo", count: 1 };
  return { key: "yearsAgo", count: years };
}

/**
 * Human-friendly relative time: "just now", "3 min ago", "2 hours ago", "5 days ago", etc.
 * English-only fallback — prefer useTimeAgo() hook for i18n-aware formatting.
 */
export function timeAgo(input: Date | string | number): string {
  const { key, count } = timeAgoParts(input);
  const map: Record<string, string> = {
    justNow: "just now",
    minuteAgo: "1 min ago",
    minutesAgo: `${count} min ago`,
    hourAgo: "1 hour ago",
    hoursAgo: `${count} hours ago`,
    dayAgo: "1 day ago",
    daysAgo: `${count} days ago`,
    monthAgo: "1 month ago",
    monthsAgo: `${count} months ago`,
    yearAgo: "1 year ago",
    yearsAgo: `${count} years ago`,
  };
  return map[key] ?? "";
}

/**
 * Format a MeOS YYYYMMDD integer as "YYYY-MM-DD".
 * Returns "" for invalid / zero values.
 */
export function formatEntryDate(d: number): string {
  if (!d || d < 19000101) return "";
  const s = String(d);
  if (s.length !== 8) return String(d);
  return `${s.substring(0, 4)}-${s.substring(4, 6)}-${s.substring(6, 8)}`;
}
