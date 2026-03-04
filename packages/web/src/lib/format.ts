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
 * Human-friendly relative time: "just now", "3 min ago", "2 hours ago", "5 days ago", etc.
 */
export function timeAgo(input: Date | string | number): string {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return "just now"; // future date → treat as "just now"

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return "1 min ago";
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "1 hour ago";
  if (hours < 24) return `${hours} hours ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;

  const months = Math.floor(days / 30);
  if (months === 1) return "1 month ago";
  if (months < 12) return `${months} months ago`;

  const years = Math.floor(days / 365);
  if (years === 1) return "1 year ago";
  return `${years} years ago`;
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
