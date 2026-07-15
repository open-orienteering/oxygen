# Venue Box Runbook

How to run an Oxygen venue node — a laptop or mini-PC at the competition
venue that owns all race-critical writes while internet connectivity is
unreliable, continuously shipping the journal to the cloud. Architecture
background: [`offline-architecture.md`](offline-architecture.md).

## What you need

- A box with Docker + docker compose (a mid-range laptop is plenty; a
  Raspberry Pi 5 works for small events).
- A LAN that the box and every station device share (a travel Wi-Fi router
  is fine; internet on that LAN is optional but recommended for shipping).
- The cloud node reachable over HTTPS, with `SYNC_SHARED_SECRET` set in its
  environment.
- Chrome 142+ on station devices that will use the cloud-served PWA against
  the box (see [Transport](#transport-how-stations-reach-the-box)).

## One-time setup

1. Clone the repo on the box and create `.env.venue`:

   ```bash
   VENUE_NODE_ID=venue-myclub-1          # stable, unique per box
   SYNC_PEER_URL=https://oxygen.example.com
   SYNC_SHARED_SECRET=<same value as on the cloud>
   CLOUD_WEB_ORIGIN=https://oxygen.example.com
   ```

2. Build and start the stack, then apply migrations:

   ```bash
   docker compose -f docker-compose.venue.yml --env-file .env.venue up --build -d
   docker compose -f docker-compose.venue.yml exec api \
     pnpm --filter @oxygen/api exec prisma migrate deploy
   ```

3. **Disable sleep.** A suspended box ships nothing and serves nobody:

   ```bash
   # Linux (systemd)
   sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
   # Also disable lid-close suspend in /etc/systemd/logind.conf:
   #   HandleLidSwitch=ignore
   ```

4. Give the box a static IP on the venue LAN (router DHCP reservation), or
   rely on mDNS (`hostname.local`) if every station OS resolves it.

5. Verify from another device on the LAN:

   ```bash
   curl http://<box-ip>:3001/health   # → {"status":"ok",...}
   ```

## Race day

### Checkout

1. On any admin device, open the event's **Event page → Venue mode** panel
   *against the venue box* (see transport below) and press **Check out to
   this node**. This acquires the lease on the cloud, imports the event
   snapshot, and makes the box the single writer for race-critical data.
2. The shell shows the green **Venue mode** badge. From this moment the
   cloud rejects race-critical writes for this event with "checked out to
   `<node>`".

### Transport: how stations reach the box

Two options, both fine:

- **Cloud-served PWA + LNA (recommended for Chrome devices).** Stations
  load the app from the cloud over HTTPS as usual, then set the box's URL
  under **Sync status → Venue node URL** (e.g. `http://192.168.1.10:3001`).
  The discovery loop probes `/health` every 15 s; when the box is healthy,
  all API calls go to it over the LAN. Chrome asks once for the "local
  network" permission — accept it. If the box goes down, calls fall back
  to the cloud automatically, and climb back when it returns.
- **LAN-served web UI (any browser, zero internet).** Browse
  `http://<box-ip>:8080` directly. Same-origin plain HTTP: no LNA, no
  permission prompt, works on iOS/Safari/Firefox. Use this for devices
  that can't run Chrome 142+.

**iOS / non-Chrome devices using the cloud-served PWA stay cloud-direct**
(LNA is Chrome-only). During a venue checkout their race-critical writes
get the typed "checked out" error — hand those devices the LAN-served UI
instead.

### During the race

- The **Venue mode** badge shows unshipped-entry count; the Event page
  panel shows "All journal entries shipped" when the uplink is keeping up.
  Shipping lag = data-loss exposure if the box dies, so keep an eye on it.
- ROC punches keep arriving at the **cloud** and flow to the box through
  the shipper's pull direction — no ROC reconfiguration needed.
- Cloud-owned admin (Eventor sync, club directory, report templates) is
  forwarded upstream when the box has internet, and fails with a clear
  "requires connectivity" error when it doesn't. Don't fight it — nothing
  in that set affects results.
- Station devices with the **offline resilience mode** toggle on (sync
  panel) additionally survive LAN blips: reads come from their local
  snapshot cache, writes queue in the outbox and drain on reconnect.

### Checkin

When results are final (or connectivity is restored for good), press
**Check in** on the Event page against the box. This runs a final ship
cycle, verifies every journal entry is acked by the cloud (it refuses
otherwise), and releases the lease on both nodes. The cloud is the writer
again; the box can be shut down.

### If the box dies mid-race

1. On the **cloud**, open the event's Venue mode panel and press **Force
   takeover** (explicit confirmation required). The recovery point is
   whatever the box last shipped — the badge told you how far behind it
   was.
2. Point stations back at the cloud (clear the venue URL, or they fall
   back automatically within 15 s).
3. Station outboxes retain unacked entries and drain them into the cloud.
4. If the box revives, its unshipped journal entries drain through
   `events.push` idempotently; conflicts are logged loudly on the cloud.

## Troubleshooting

| Symptom | Check |
|---|---|
| Badge stuck amber with growing count | Box's internet uplink; `docker compose logs api \| grep shipper` |
| "checked out to venue-…" on a station | That device is talking to the cloud — set the venue URL or use the LAN UI |
| Permission prompt never appears (Chrome) | `chrome://flags` LNA not disabled; URL really is private-range or `.local` |
| Stations can't reach the box at all | Firewall on the box (allow 3001/8080), station on the same LAN/VLAN |
| `checkin` refuses | It's the barrier working: fix connectivity, watch the pending count drain, retry |
