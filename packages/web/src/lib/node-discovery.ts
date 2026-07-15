/**
 * Node discovery + LNA transport (pivot Step 5).
 *
 * A station PWA (served over HTTPS from the cloud) can talk to a venue box
 * over plain HTTP on the LAN. Chrome 142+ Local Network Access lifts
 * mixed-content blocking for requests it knows target the local network —
 * private-IP literals, `.local` hostnames, or fetches annotated with
 * `targetAddressSpace: "local"` — behind a one-time user permission. The
 * venue box therefore needs NO TLS certificate.
 *
 * Discovery is deliberately simple and operator-driven:
 *   1. Candidates: the pinned venue URL(s) from localStorage (comma
 *      separated; set in the sync panel).
 *   2. A probe loop hits each candidate's `/health` in order; the first
 *      healthy one becomes the active node.
 *   3. No candidate healthy → cloud fallback (same-origin, exactly the
 *      pre-Step-5 behaviour).
 *   4. The loop keeps probing while on the cloud, so when the venue box
 *      comes (back) up the client climbs back automatically.
 *
 * iOS / non-Chrome clients: LNA is Chrome-only, so they stay cloud-direct —
 * probes to an HTTP venue URL from an HTTPS page simply fail as mixed
 * content and the fallback keeps them on the cloud. (On the venue's own
 * LAN-served page, or plain-HTTP dev, everything works everywhere.)
 */

import { useSyncExternalStore } from "react";

const VENUE_URLS_KEY = "oxygen-venue-urls";
const PROBE_INTERVAL_MS = 15_000;
const PROBE_TIMEOUT_MS = 3_000;

// ─── URL classification ──────────────────────────────────────

/**
 * True when a URL targets the local network — a private/loopback IPv4
 * literal or a `.local` (mDNS) hostname. Drives the `targetAddressSpace`
 * annotation Chrome's LNA needs on fetches to names it can't classify
 * up front.
 */
export function isLocalNetworkUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) {
    return true;
  }
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 127
  );
}

/** RequestInit extension for Chrome LNA (not yet in lib.dom). */
interface LnaRequestInit extends RequestInit {
  targetAddressSpace?: "local" | "private" | "public";
}

/** Fetch options for a venue base URL: LNA annotation when it's local. */
export function lnaInit(baseUrl: string, init: RequestInit = {}): RequestInit {
  if (!isLocalNetworkUrl(baseUrl)) return init;
  const annotated: LnaRequestInit = { ...init, targetAddressSpace: "local" };
  return annotated;
}

// ─── Candidates (operator-pinned) ────────────────────────────

export function getVenueCandidates(): string[] {
  try {
    const raw = localStorage.getItem(VENUE_URLS_KEY) ?? "";
    return raw
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter((s) => /^https?:\/\//.test(s));
  } catch {
    return [];
  }
}

export function setVenueCandidates(urls: string): void {
  try {
    if (urls.trim().length === 0) localStorage.removeItem(VENUE_URLS_KEY);
    else localStorage.setItem(VENUE_URLS_KEY, urls);
  } catch {
    /* localStorage unavailable — discovery stays cloud-only */
  }
  notify();
  void probeNow();
}

export function getVenueCandidatesRaw(): string {
  try {
    return localStorage.getItem(VENUE_URLS_KEY) ?? "";
  } catch {
    return "";
  }
}

// ─── Probing ─────────────────────────────────────────────────

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** One `/health` probe. Exported for tests (fetch injectable). */
export async function probeCandidate(
  baseUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetchImpl(
        `${baseUrl}/health`,
        lnaInit(baseUrl, { signal: ctrl.signal, cache: "no-store" }),
      );
      if (!res.ok) return false;
      const body = (await res.json()) as { status?: string };
      return body.status === "ok";
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/**
 * Pick the active node: the first healthy candidate, or "" (cloud /
 * same-origin). Pure given a probe function — unit-tested directly.
 */
export async function selectActiveNode(
  candidates: string[],
  probe: (url: string) => Promise<boolean> = probeCandidate,
): Promise<string> {
  for (const c of candidates) {
    if (await probe(c)) return c;
  }
  return "";
}

// ─── Active-node store ───────────────────────────────────────

let activeBaseUrl = "";
let probing = false;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

/** "" = cloud (same-origin). Non-empty = venue base URL. */
export function getActiveBaseUrl(): string {
  return activeBaseUrl;
}

export async function probeNow(): Promise<void> {
  if (probing) return;
  probing = true;
  try {
    const next = await selectActiveNode(getVenueCandidates());
    if (next !== activeBaseUrl) {
      console.log(
        `[node-discovery] Active node: ${next || "cloud (same-origin)"}`,
      );
      activeBaseUrl = next;
      notify();
    }
  } finally {
    probing = false;
  }
}

/** Start the background probe loop. Idempotent; no-op with no candidates
 * (the interval still runs so pinning a URL later takes effect). */
export function startNodeDiscovery(): void {
  if (timer) return;
  void probeNow();
  timer = setInterval(() => void probeNow(), PROBE_INTERVAL_MS);
}

export function stopNodeDiscovery(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** React hook: the active base URL ("" = cloud). */
export function useActiveNode(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getActiveBaseUrl,
    () => "",
  );
}

// ─── Venue-aware fetch (tRPC transport) ──────────────────────

/**
 * The custom `fetch` for the tRPC links: rewrites same-origin API paths
 * (`/trpc/...`) onto the active venue base URL and annotates the request
 * for LNA. With no venue active this is a plain pass-through — byte-for-
 * byte the pre-Step-5 behaviour.
 */
export function venueAwareFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const base = getActiveBaseUrl();
  if (!base) return fetch(input, init);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("/")) return fetch(input, init);
  return fetch(`${base}${url}`, lnaInit(base, init ?? {}));
}
