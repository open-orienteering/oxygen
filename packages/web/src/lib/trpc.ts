import { createTRPCReact } from "@trpc/react-query";
import { createTRPCClient, httpBatchLink, httpLink } from "@trpc/client";
import type { AppRouter } from "@oxygen/api";
import { rejectHtmlApiResponse } from "./html-api-response";
import { venueAwareFetch } from "./node-discovery";
import { cloudOwnedApart, withRequestTimeout } from "./trpc-links";

export const trpc = createTRPCReact<AppRouter>();

/**
 * Vanilla (non-React) tRPC client for use outside of React components,
 * e.g. in the offline event sync worker.
 */
function getApiUrl() {
  return import.meta.env.VITE_API_URL
    ? `${import.meta.env.VITE_API_URL}/trpc`
    : "/trpc";
}

const RESERVED_EVENT_SLUGS = new Set(["admin", "library", "settings"]);

export function activeEventNameId(): string | null {
  const match = window.location.pathname.match(/^\/([^/]+)/);
  const nameId = match?.[1];
  return nameId && !RESERVED_EVENT_SLUGS.has(nameId) ? nameId : null;
}

function getCompetitionHeader(): Record<string, string> {
  const nameId = activeEventNameId();
  return nameId ? { "x-competition-id": nameId } : {};
}

/** Add event identity to the URL (the service worker no longer caches /trpc; the query keeps the event visible in logs and in the network panel). */
export function scopeTrpcUrl(url: string, nameId: string | null): string {
  if (!nameId) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}event=${encodeURIComponent(nameId)}`;
}

async function fetchJsonApi(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return rejectHtmlApiResponse(await venueAwareFetch(input, init));
}

/** A fetch scoped to the event `getNameId` names (the URL's, or one fixed id). */
export function makeEventScopedFetch(getNameId: () => string | null) {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const nameId = getNameId();
    if (typeof input === "string") {
      return fetchJsonApi(scopeTrpcUrl(input, nameId), init);
    }
    if (input instanceof URL) {
      return fetchJsonApi(new URL(scopeTrpcUrl(input.href, nameId)), init);
    }
    if (!nameId) return fetchJsonApi(input, init);
    return fetchJsonApi(
      new Request(scopeTrpcUrl(input.url, nameId), input),
      init,
    );
  };
}

export const eventScopedTrpcFetch = makeEventScopedFetch(activeEventNameId);

/**
 * The outbox drain's push gives up after this long (SYNC-11): with no
 * timeout a request to a node that went away can hang for minutes, and
 * the drain cannot retry while it waits. A timeout counts as a network
 * failure (`isNetworkFailure`), so the auto-drain retries with backoff.
 */
export const DRAIN_REQUEST_TIMEOUT_MS = 60_000;

const eventClients = new Map<string, ReturnType<typeof createEventClient>>();

function createEventClient(nameId: string) {
  return createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: getApiUrl(),
        fetch: withRequestTimeout(makeEventScopedFetch(() => nameId), DRAIN_REQUEST_TIMEOUT_MS),
        headers: () => ({ "x-competition-id": nameId }),
      }),
    ],
  });
}

/**
 * A vanilla client pinned to one event: header and `?event=` come from
 * `nameId`, never from the page URL. The outbox drain uses it so an entry
 * always reaches the competition it was made in (MC-01, BLD-04).
 */
export function trpcClientForEvent(nameId: string) {
  let client = eventClients.get(nameId);
  if (!client) {
    client = createEventClient(nameId);
    eventClients.set(nameId, client);
  }
  return client;
}

export const trpcVanillaClient = createTRPCClient<AppRouter>({
  links: [
    // Cloud-owned mutations batch apart: a venue refuses a mixed batch (row G18).
    cloudOwnedApart<AppRouter>(() =>
      httpBatchLink({
        url: getApiUrl(),
        // Outbox drains follow the active node too — a station on venue
        // Wi-Fi drains into the venue box, not across the WAN.
        fetch: eventScopedTrpcFetch,
        headers: getCompetitionHeader,
      }),
    ),
  ],
});
