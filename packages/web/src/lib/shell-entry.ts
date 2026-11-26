/**
 * How the competition shell opens an event (WEB-03).
 *
 * With a dashboard for this event in the persisted cache the shell opens
 * from it at once and `competition.select` runs in the background. Only a
 * definite answer from the server closes it again: NOT_FOUND (the event is
 * gone) or a refusal (no access). Any other failure (no answer, a proxy's
 * 502, a server error) keeps the cached shell open and retries; without a
 * cache it shows a retry page instead of a dead end.
 */

export type ShellEntry =
  /** No cache, first select in flight: spinner. */
  | "loading"
  /** Opened from cache, first select in flight. */
  | "provisional"
  /** The server confirmed the event. */
  | "live"
  /** Opened from cache, the server cannot be reached: retrying. */
  | "cached"
  /** No cache and no server: the retry page. */
  | "unreachable"
  | "not-found"
  /** The server refused (UNAUTHORIZED / FORBIDDEN). */
  | "refused";

export type SelectState =
  | { status: "pending" }
  | { status: "success" }
  | { status: "error"; error: unknown };

function errorCode(err: unknown): string | undefined {
  const code = (err as { data?: { code?: unknown } | null } | null)?.data?.code;
  return typeof code === "string" ? code : undefined;
}

export function decideShellEntry({
  cachedName,
  select,
  failedBefore,
}: {
  /** The event's name from the cached dashboard, or null without one. */
  cachedName: string | null;
  select: SelectState;
  /** An earlier select for this event failed (a retry is now in flight). */
  failedBefore: boolean;
}): ShellEntry {
  const offline = (): ShellEntry => (cachedName ? "cached" : "unreachable");
  switch (select.status) {
    case "success":
      return "live";
    case "pending":
      if (failedBefore) return offline();
      return cachedName ? "provisional" : "loading";
    case "error": {
      const code = errorCode(select.error);
      if (code === "NOT_FOUND") return "not-found";
      if (code === "UNAUTHORIZED" || code === "FORBIDDEN") return "refused";
      return offline();
    }
  }
}

/** The shell renders the event (header, tabs, pages) in these states. */
export function shellIsOpen(entry: ShellEntry): boolean {
  return entry === "live" || entry === "provisional" || entry === "cached";
}

/** The select is retried on a timer in these states. */
export function shellRetries(entry: ShellEntry): boolean {
  return entry === "cached" || entry === "unreachable";
}
