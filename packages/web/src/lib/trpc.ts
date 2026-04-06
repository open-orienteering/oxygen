import { createTRPCReact } from "@trpc/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@oxygen/api";

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

function getCompetitionHeader(): Record<string, string> {
  const match = window.location.pathname.match(/^\/([^/]+)/);
  const nameId = match?.[1];
  return nameId ? { "x-competition-id": nameId } : {};
}

export const trpcVanillaClient = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: getApiUrl(),
      headers: getCompetitionHeader,
    }),
  ],
});
