/**
 * Node identity + peer configuration (pivot Step 3).
 *
 * Every Oxygen server process is a *node*: the long-running cloud instance
 * or a portable venue box. Identity and peering are pure env config so the
 * same image runs in either role:
 *
 *   - `NODE_ID`             stable identifier, doubles as the journal
 *                           `station_id` for server-originated entries
 *                           (default "cloud").
 *   - `NODE_ROLE`           "cloud" | "venue" (default "cloud"). Informational
 *                           in Step 3; lease enforcement (Step 4) keys off it.
 *   - `SYNC_PEER_URL`       base URL of the peer node's API (e.g.
 *                           "https://oxygen.example.com" or
 *                           "http://192.168.1.10:3001"). Setting it enables
 *                           the journal shipper. The venue dials the cloud —
 *                           the cloud normally has no peer configured.
 *   - `SYNC_SHARED_SECRET`  shared bearer for node-to-node calls. Guards
 *                           `events.since` (the pull side); must be set on
 *                           both nodes for shipping to work.
 *   - `SYNC_INTERVAL_MS`    shipper cadence (default 5000).
 *
 * Read lazily so tests (and the migration tool) can adjust `process.env`
 * before first use.
 */

export type NodeRole = "cloud" | "venue";

export function nodeId(): string {
  return process.env.NODE_ID ?? "cloud";
}

export function nodeRole(): NodeRole {
  return process.env.NODE_ROLE === "venue" ? "venue" : "cloud";
}

/** Peer base URL, or null when this node has no peer (shipping disabled). */
export function syncPeerUrl(): string | null {
  const raw = process.env.SYNC_PEER_URL?.trim();
  if (!raw) return null;
  // Normalize: no trailing slash so `${url}/trpc` composes cleanly.
  return raw.replace(/\/+$/, "");
}

export function syncSharedSecret(): string | null {
  const raw = process.env.SYNC_SHARED_SECRET;
  return raw && raw.length > 0 ? raw : null;
}

export function syncIntervalMs(): number {
  const raw = parseInt(process.env.SYNC_INTERVAL_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 250 ? raw : 5000;
}

/** Request header carrying the shared secret on node-to-node calls. */
export const SYNC_SECRET_HEADER = "x-oxygen-sync-secret";
