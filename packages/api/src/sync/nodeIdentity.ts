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
 *                           `events.since` (the pull side) and authorises a
 *                           peer's `events.push` (no user needed); must be
 *                           set on both nodes for shipping to work.
 *   - `SYNC_INTERVAL_MS`    shipper cadence (default 5000).
 *
 * Read lazily so tests (and the migration tool) can adjust `process.env`
 * before first use.
 */

export type NodeRole = "cloud" | "venue";

export function nodeId(): string {
  return process.env.NODE_ID ?? "cloud";
}

/** Whether this node still has the default identity "cloud" (NODE_ID unset or empty): a venue box must have its own. */
export function nodeIdIsDefault(): boolean {
  const id = nodeId().trim();
  return id === "" || id === "cloud";
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

/**
 * Cadence for refreshing the venue's copy of cloud-owned event settings
 * while a lease is held (default 5 min). `SYNC_SETTINGS_REFRESH_MS`.
 */
export function syncSettingsRefreshMs(): number {
  const raw = parseInt(process.env.SYNC_SETTINGS_REFRESH_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 5_000 ? raw : 300_000;
}

/** Request header carrying the shared secret on node-to-node calls. */
export const SYNC_SECRET_HEADER = "x-oxygen-sync-secret";

/**
 * Request header carrying the calling node's `NODE_ID` on node-to-node calls,
 * so the receiving node can tell a stale holder's delivery from a current one
 * (review SYNC-08). It is also what a forwarded call's authority is keyed on
 * (`ctx.nodeForward`, all capabilities on events whose lease that id holds).
 * It is NOT proof of identity: with one instance-wide `SYNC_SHARED_SECRET`, a
 * box that knows the secret can claim another box's node id (follow-up: a
 * per-event checkout token, docs/bugfixes/proxy-auth-followups.md).
 */
export const SYNC_NODE_ID_HEADER = "x-oxygen-node-id";

/**
 * Marks a venue's forwarded cloud-owned mutation (`venueForwarder.ts`).
 * With a valid node secret the cloud runs the call as that node, not as a
 * signed-in user (`Context.nodeForward`, docs/system/authentication.md
 * "Venue nodes"). Without the secret the marker grants nothing.
 */
export const SYNC_FORWARDED_HEADER = "x-oxygen-forwarded";
/**
 * The capabilities the forwarding box found its signed-in caller to hold on
 * the event (comma list; an admin sends them all, `event.manage` is not
 * assumed). The cloud intersects it with the lease-holder rule, so a forward
 * never does more than the person at the box could do. Absent from a box with
 * login off.
 */
export const SYNC_FORWARDED_CAPS_HEADER = "x-oxygen-forwarded-caps";
