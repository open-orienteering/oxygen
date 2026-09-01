/**
 * Optional Google service-account ID-token auth for venue → cloud calls.
 *
 * When the cloud instance runs behind Identity-Aware Proxy (see
 * docs/deploy-gcp-cloud-run.md), plain HTTP requests are rejected before
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
