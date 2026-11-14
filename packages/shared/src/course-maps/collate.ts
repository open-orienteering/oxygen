/**
 * The one string order the print pipeline sorts labels and codes by
 * (docs/course-print.md §8.6 "What identity rests on", G16): English
 * collation with numeric runs compared as numbers, so `9` sorts before
 * `10`. Pinned rather than the host's default locale, so a Swedish browser
 * composing a print job orders sites and breaks label ties exactly as the
 * server (whose default locale is en-US) does — the same bytes either way.
 */

const collator = new Intl.Collator("en", { numeric: true });

/** `a` before `b` < 0, equal 0, after > 0 — `localeCompare(…, "en", { numeric: true })`. */
export function compareLabels(a: string, b: string): number {
  return collator.compare(a, b);
}
