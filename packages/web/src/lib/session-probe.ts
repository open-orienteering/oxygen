/**
 * Is the server unreachable, or did the sign-in session expire? (WEB-04)
 *
 * A failed `users.me` / `competition.select` looks the same in both cases:
 * a network-class error with no tRPC code (an expired IAP cookie redirects
 * to accounts.google.com, which fails as CORS "Failed to fetch"; some
 * setups answer the login page as HTML). Only an expired session is fixed
 * by a full reload; reloading during an outage just throws the open station
 * away. The probe asks once, without following redirects and without any
 * cache, and tells the two apart.
 *
 * The service worker has no `/trpc` route (SYNC-16), so this request always
 * reaches the network.
 */

export type ProbeResult = "ok" | "expired" | "unreachable";

export interface ProbeResponse {
  type: string;
  status: number;
  contentType: string;
}

/** Sort one probe answer (pure; the fetch is in `probeSession`). */
export function classifyProbe(res: ProbeResponse | null): ProbeResult {
  // The request never got an answer: no network, DNS, the node is down.
  if (!res) return "unreachable";
  // `redirect: "manual"`: a redirect (to the IAP sign-in) comes back opaque.
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) return "expired";
  const json = res.contentType.includes("application/json");
  if (json) {
    // Our own server answered. A 5xx from it means it is up but failing:
    // reloading would not help, so treat it like unreachable.
    return res.status >= 500 ? "unreachable" : "ok";
  }
  // A proxy in front of a node that is down or restarting.
  if (res.status === 502 || res.status === 503 || res.status === 504) return "unreachable";
  // A login page served in place of the API, or a proxy's 401/403.
  if (res.status === 401 || res.status === 403 || res.contentType.includes("text/html")) return "expired";
  return "unreachable";
}

/**
 * Probe `users.me` on this origin. With a venue node active the request
 * would go to the box, which has no IAP: an unreachable box is never a
 * session problem, so the answer is "unreachable" without asking.
 */
export async function probeSession(
  fetchImpl: typeof fetch = fetch,
  activeBaseUrl = "",
  apiUrl = "/trpc",
  timeoutMs = 8_000,
): Promise<ProbeResult> {
  if (activeBaseUrl !== "") return "unreachable";
  try {
    const res = await fetchImpl(`${apiUrl}/users.me`, {
      redirect: "manual",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "X-Requested-With": "XMLHttpRequest" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return classifyProbe({ type: res.type, status: res.status, contentType: res.headers.get("content-type") ?? "" });
  } catch {
    return classifyProbe(null);
  }
}
