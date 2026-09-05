import { createTRPCReact } from "@trpc/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@oxygen/api";
import { venueAwareFetch } from "./node-discovery";

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

function activeEventNameId(): string | null {
  const match = window.location.pathname.match(/^\/([^/]+)/);
  const nameId = match?.[1];
  return nameId && !RESERVED_EVENT_SLUGS.has(nameId) ? nameId : null;
}

function getCompetitionHeader(): Record<string, string> {
  const nameId = activeEventNameId();
  return nameId ? { "x-competition-id": nameId } : {};
}

/** Add event identity to the URL so the service-worker cache is event-scoped. */
export function scopeTrpcUrl(url: string, nameId: string | null): string {
  if (!nameId) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}event=${encodeURIComponent(nameId)}`;
}

export function eventScopedTrpcFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const nameId = activeEventNameId();
  if (typeof input === "string") {
    return venueAwareFetch(scopeTrpcUrl(input, nameId), init);
  }
  if (input instanceof URL) {
    return venueAwareFetch(new URL(scopeTrpcUrl(input.href, nameId)), init);
  }
  if (!nameId) return venueAwareFetch(input, init);
  return venueAwareFetch(
    new Request(scopeTrpcUrl(input.url, nameId), input),
    init,
  );
}

export const trpcVanillaClient = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: getApiUrl(),
      // Outbox drains follow the active node too — a station on venue
      // Wi-Fi drains into the venue box, not across the WAN.
      fetch: eventScopedTrpcFetch,
      headers: getCompetitionHeader,
    }),
  ],
});
