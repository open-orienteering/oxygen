/**
 * Optional Google service-account ID-token auth for venue → cloud calls.
 *
 * When the cloud instance runs behind Identity-Aware Proxy (see
 * docs/ops/deploy-gcp-cloud-run.md), plain HTTP requests are rejected before
 * they reach the API. IAP accepts programmatic callers that present an
 * OIDC ID token for a service account with the "IAP-secured Web App User"
 * role, with the token's audience set to the IAP OAuth client ID.
 *
 * Configuration (venue box only):
 *
 *   - `SYNC_GOOGLE_AUDIENCE`            the IAP OAuth client ID. Setting it
 *                                       turns the sync headers into an async
 *                                       provider that attaches
 *                                       `Authorization: Bearer <ID token>`.
 *   - `GOOGLE_APPLICATION_CREDENTIALS`  path to the service-account key
 *                                       file (standard google-auth-library
 *                                       discovery).
 *
 * Unset audience = today's behavior: static headers, shared secret only.
 * The existing `x-oxygen-sync-secret` header always travels too — IAP is
 * the outer wall, the shared secret stays as the app-level check.
 */

// google-auth-library's IdTokenClient caches the token and re-fetches
// only when it is near expiry, so calling it per request is cheap.
type IdTokenClientLike = { idTokenProvider: { fetchIdToken(aud: string): Promise<string> } };

export type IdTokenFetcher = (audience: string) => Promise<string>;

let injectedFetcher: IdTokenFetcher | null = null;

/** Test seam: unit tests swap in a fake fetcher (null restores default). */
export function _setIdTokenFetcher(f: IdTokenFetcher | null): void {
  injectedFetcher = f;
}

/** IAP audience for venue → cloud calls, or null when IAP auth is off. */
export function syncGoogleAudience(): string | null {
  const raw = process.env.SYNC_GOOGLE_AUDIENCE?.trim();
  return raw ? raw : null;
}

let cachedClient: { audience: string; client: IdTokenClientLike } | null = null;

async function defaultFetcher(audience: string): Promise<string> {
  if (!cachedClient || cachedClient.audience !== audience) {
    // Lazy import: only the venue box configures IAP auth; everyone else
    // never loads google-auth-library.
    const { GoogleAuth } = await import("google-auth-library");
    const client = await new GoogleAuth().getIdTokenClient(audience);
    cachedClient = { audience, client };
  }
  return cachedClient.client.idTokenProvider.fetchIdToken(audience);
}

/**
 * Wrap the static node-to-node headers with IAP auth when configured.
 * Returns the input untouched when `SYNC_GOOGLE_AUDIENCE` is unset, or an
 * async provider (the shape tRPC's `httpLink` accepts) that merges in a
 * fresh `Authorization` header per request otherwise.
 */
export function makeSyncHeaders(
  base: Record<string, string>,
): Record<string, string> | (() => Promise<Record<string, string>>) {
  const audience = syncGoogleAudience();
  if (!audience) return base;
  return async () => ({
    ...base,
    authorization: `Bearer ${await (injectedFetcher ?? defaultFetcher)(audience)}`,
  });
}

/**
 * One startup line for a venue node: is IAP auth on, and is the key file the
 * audience needs actually readable? A misconfigured box otherwise only shows
 * itself as 401s from the cloud at the arena (docs/ops/venue-runbook.md).
 */
export function describeSyncAuth(
  env: Record<string, string | undefined>,
  canRead: (path: string) => boolean,
): { level: "info" | "warn"; message: string } {
  const audience = env.SYNC_GOOGLE_AUDIENCE?.trim();
  const keyPath = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (audience && !keyPath) {
    return {
      level: "warn",
      message:
        "[sync] SYNC_GOOGLE_AUDIENCE is set but GOOGLE_APPLICATION_CREDENTIALS is not: no ID token can be minted, the cloud's IAP will reject sync calls. Set VENUE_SA_KEY in .env.venue.",
    };
  }
  if (audience && keyPath && !canRead(keyPath)) {
    return {
      level: "warn",
      message: `[sync] IAP auth is configured but the key file ${keyPath} is missing or unreadable (the container runs as uid 1000: chown 1000, chmod 400): sync calls will be rejected by IAP.`,
    };
  }
  if (!audience && keyPath) {
    return {
      level: "warn",
      message:
        "[sync] GOOGLE_APPLICATION_CREDENTIALS is set but SYNC_GOOGLE_AUDIENCE is not: no ID token is sent, an IAP-protected cloud will reject sync calls. Set SYNC_GOOGLE_AUDIENCE in .env.venue.",
    };
  }
  if (audience) {
    return { level: "info", message: "[sync] IAP auth on: sync calls carry a Google ID token." };
  }
  return {
    level: "info",
    message: "[sync] IAP auth off: sync calls carry the shared secret only (the cloud must not be behind IAP).",
  };
}
