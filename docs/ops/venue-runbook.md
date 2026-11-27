# Venue Box Runbook

How to run an Oxygen venue node — a laptop or mini-PC at the competition
venue that owns all race-critical writes while internet connectivity is
unreliable, continuously shipping the journal to the cloud. Architecture
background: [`system/offline-architecture.md`](../system/offline-architecture.md).

## What you need

- A box with Docker + docker compose (a mid-range laptop is plenty; a
  Raspberry Pi 5 works for small events).
- A LAN that the box and every station device share (a travel Wi-Fi router
  is fine; internet on that LAN is optional but recommended for shipping).
- The cloud node reachable over HTTPS, with `SYNC_SHARED_SECRET` set in its
  environment. The same value authorises the box's push to the cloud as well
  as its pull; if it is missing or different the shipper logs
  `UNAUTHORIZED` / `PRECONDITION_FAILED` every cycle and nothing ships.
  `scripts/gcp/provision.sh` creates it as the secret `oxygen-sync-secret`
  and `deploy.sh` binds it on every deploy (read it with
  `gcloud secrets versions access latest --secret=oxygen-sync-secret`). A
  cloud deployed with `deploy.sh` is behind IAP: the box needs the two IAP
  lines below as well.
- Chrome 142+ on station devices that will use the cloud-served PWA against
  the box (see [Transport](#transport-how-stations-reach-the-box)).

## One-time setup

1. Clone the repo on the box and create `.env.venue`:

   ```bash
   VENUE_NODE_ID=venue-myclub-1          # stable, unique per box
   SYNC_PEER_URL=https://oxygen.example.com
   SYNC_SHARED_SECRET=<same value as on the cloud: it authorises push and pull>
   CLOUD_WEB_ORIGIN=https://oxygen.example.com
   # Cloud behind IAP (a deploy made with scripts/gcp/deploy.sh always is):
   SYNC_GOOGLE_AUDIENCE=<the IAP OAuth client ID>
   VENUE_SA_KEY=/home/me/oxygen-keys/venue-sa.json   # absolute or ./ path
   ```

   Create the service account and its key as described in
   [deploy-gcp-cloud-run.md](deploy-gcp-cloud-run.md#venue-box-sync-through-iap),
   keep the key file outside the checkout, and make it readable by the
   container's user (uid 1000): `chown 1000 venue-sa.json && chmod 400
   venue-sa.json`. A bare file name would be taken as a Docker volume, so
   use a full path or one starting with `./`. At start the api logs
   `[sync] IAP auth on` or a warning that names what is missing
   (`docker compose -f docker-compose.venue.yml logs api | grep '\[sync\]'`).

2. Build and start the stack:

   ```bash
   docker compose -f docker-compose.venue.yml --env-file .env.venue up --build -d
   ```

   The compose file's `migrate` service applies the Prisma migrations before
   the api starts (and again on every `up`); no separate command is needed.
   If it fails, `docker compose -f docker-compose.venue.yml logs migrate`
   says why and the api stays down.

3. **Disable sleep.** A suspended box ships nothing and serves nobody:

   ```bash
   # Linux (systemd)
   sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
   # Also disable lid-close suspend in /etc/systemd/logind.conf:
   #   HandleLidSwitch=ignore
   ```

4. Give the box a static IP on the venue LAN (router DHCP reservation), or
   rely on mDNS (`hostname.local`) if every station OS resolves it.

5. Verify from another device on the LAN. `/ready` answers 200 only when
   the database is reachable and every migration is applied; otherwise 503
   with a `reason` (`database` or `migrations`) and the pending migrations.
   `/health` only says the process is up.

   ```bash
   curl http://<box-ip>:3001/ready   # → {"status":"ok"}
   ```

6. **Automatic backups.** The compose file's `backup` service dumps the
   whole database every 15 minutes into `./backups` next to the compose
   file and keeps the newest 48. Set `BACKUP_DIR` in `.env.venue` to a USB
   stick's mount point to keep a copy off the box's disk (if the stick is
   not mounted, the dumps land on the box's disk: check with `df`). The
   48 dumps take about 48 times one dump's size, and the service deletes
   older dumps early, and skips a round, rather than fill the disk. Before the race,
   check that dumps are appearing: `ls -lt backups | head -3` (or
   `docker compose -f docker-compose.venue.yml logs backup`). See
   [backup-restore.md](backup-restore.md#automatic-backups) for restoring
   from one.

## Upgrading the box

Do this days before the event, not at the arena, and never while the box
holds a lease.

1. Check the box in (or confirm no event is checked out to it).
2. Take a dump that the 15-minute rotation will not delete:

   ```bash
   docker compose -f docker-compose.venue.yml --env-file .env.venue \
     run --rm --entrypoint pg_dump backup --schema=oxygen --format=custom \
     --file=/backups/pre-upgrade_$(date -u +%Y%m%d_%H%M%S).dump
   ```

   (`pre-upgrade_*` does not match the rotation's `oxygen_*.dump`.)
3. `git pull` (or check out the release tag), then rebuild and start:

   ```bash
   docker compose -f docker-compose.venue.yml --env-file .env.venue up --build -d
   ```

   `migrate` runs first; the api and web wait for it and for `/ready`.
4. Check `curl http://<box-ip>:3001/ready` answers `{"status":"ok"}`, then
   reload the station and admin tabs that use the box. Upgrade the cloud
   first when both change (the box refuses nothing it does not understand,
   but warns about a schema mismatch in its log).

Restoring the pre-upgrade dump: [backup-restore.md](backup-restore.md#before-an-upgrade).

## Race day

### Checkout

0. Before checking out, check the event's **zero time** and **time zone**
   under Event Info. The zero time must lie before the first start, and it
   cannot be changed while the box holds the lease (the time zone can). The time zone sets the
   station clocks; the box's own `TZ` (default `Europe/Stockholm` in the
   compose file) only names backup files and log lines.
1. On any admin device, open the event's **Event page → Venue mode** panel
   *against the venue box* (see transport below) and press **Check out to
   this node**. This acquires the lease on the cloud, imports the event
   snapshot, and makes the box the single writer for race-critical data.
   The snapshot includes the event map (the uploaded file and its
   imported document), so the box holds it locally. A map whose import
   failed has no document: upload it again (or run
   `pnpm map:rematch --event <name_id>` on the cloud) before checking
   out, or the box gets no map. The snapshot also carries the print
   layout — sheets, templates, course objects and their logos — so the
   box prints maps and description sheets itself, with or without
   internet. While the box is online it follows the cloud: a map
   re-uploaded there, and sheets, templates or logos edited there, reach
   the box within the settings refresh interval (`SYNC_SETTINGS_REFRESH_MS`,
   5 minutes by default), and an edit made on the box (forwarded to the
   cloud) shows on the box at once. Offline the box keeps printing what
   it has, so make the sheets you need (**Export ▾** or Layout mode)
   while it is online. A course object imported with **Import courses**
   on the box, or a map uploaded on the box, is replaced by the cloud's
   at the next refresh — do those on the cloud.
   Checking out again over a copy the box already holds replaces it, so
   the box asks first when that would lose something. The Venue panel
   shows a confirmation, and **Continue** repeats the checkout with the
   override:
   - *Journal entries the cloud has not received* (`CHECKOUT_UNSHIPPED`):
     the box first tries a last ship cycle, so this appears only when the
     uplink is down or an entry is stuck. Continuing discards them. Prefer
     fixing the uplink and trying again. Right after upgrading a box that
     already holds an event, it re-pushes its journal once (the delivery
     marks are backfilled conservatively), so this can fire on a checked-in
     box until one ship cycle has run: wait a minute and try again.
   - *The event was created on this box* (`CHECKOUT_LOCAL_EVENT`):
     continuing replaces it with the cloud's copy.
   - *A graphic of the cloud's copy has the same id as another event's
     graphic on this box* (`GRAPHIC_ID_CLASH`): continuing replaces the
     other event's graphic. Nothing was written before you confirmed.
   - *This box still holds the lease* (`CHECKOUT_LEASE_HELD`): check in
     first; there is no override.
   A checkout that fails halfway frees the cloud's lease again; if the
   box could not reach the cloud to do that, the log says so, and
   pressing **Check out** again is safe (taking the lease twice as the
   same box is a no-op). The box also keeps the card-readout backups it
   holds over a re-checkout. With login on, a checkout needs the event's
   **Event admin** (or an instance admin for an event the box does not
   have yet).
2. The shell shows the green **Venue mode** badge. From this moment the
   cloud rejects race-critical writes for this event with "checked out to
   `<node>`".

### Transport: how stations reach the box

Two options, both fine:

- **Cloud-served PWA + LNA (recommended for Chrome devices).** Stations
  load the app from the cloud over HTTPS as usual, then set the box's URL
  under **Sync status → Venue node URL** (e.g. `http://192.168.1.10:3001`).
  The discovery loop probes `/ready` every 15 s (`/health` on a box running
  an older image that has no `/ready`); when the box is ready (database up,
  migrations applied), all API calls go to it over the LAN. Chrome asks once for the "local
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
  in that set affects results. Course-map layout is in that set too:
  edit sheets, templates, course objects and logos **on the cloud**
  during a lease, not on the box. The box forwards such edits to the
  cloud (and needs internet for it), but its own copy does not follow
  them yet, so a second edit there conflicts and a new logo is missing
  from its prints. Printing needs no internet: **Export ▾** on the box
  prints from its copy.
- After upgrading the box, reload the station and admin tabs that use it:
  a tab still running the previous web bundle can send a layout edit in
  one request with other calls, which the box now refuses ("batched with
  local calls; nothing was run").
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

If the box's disk survives (or `BACKUP_DIR` was a USB stick), the newest
dump in the backup directory holds everything up to 15 minutes before the
failure, including entries the uplink had not shipped yet: see
[backup-restore.md](backup-restore.md#automatic-backups) for getting one
event out of it. Otherwise:

1. On the **cloud**, open the event's Venue mode panel and press **Force
   takeover** (explicit confirmation required). The recovery point is
   whatever the box last shipped — the badge told you how far behind it
   was.
2. Point stations back at the cloud (clear the venue URL, or they fall
   back automatically within 15 s).
3. Station outboxes retain unacked entries and drain them into the cloud.
4. If the box revives, it notices within one shipper cycle (about
   `SYNC_INTERVAL_MS`, 5 s) that the cloud no longer lists it as holder,
   releases its own lease and logs `the lease … was taken over`. From
   then on the box refuses race writes for the event ("This copy was
   checked in or taken over; race writes go to the cloud"), and a station
   that still pushes to it keeps its outbox and drains to the cloud once
   repointed. The box's unshipped journal entries drain into the cloud
   idempotently, and the cloud logs `stale-holder entry …` for each one it
   applies. These entries are applied as they are: if the same runner was
   corrected on the cloud after the takeover, the older value from the box
   can overwrite the correction, so check the stale-holder lines in the
   cloud log against what was edited. Press **Check in** on the revived box
   when its pending count is 0 to clear its panel.

## Troubleshooting

| Symptom | Check |
|---|---|
| Badge stuck amber with growing count | Box's internet uplink; `docker compose logs api \| grep shipper` |
| "checked out to venue-…" on a station | That device is talking to the cloud — set the venue URL or use the LAN UI |
| Permission prompt never appears (Chrome) | `chrome://flags` LNA not disabled; URL really is private-range or `.local` |
| Stations can't reach the box at all | Firewall on the box (allow 3001/8080), station on the same LAN/VLAN |
| `checkin` refuses | It's the barrier working: fix connectivity, watch the pending count drain, retry. While it runs the box refuses race writes for the event, so do not retry in a loop during a race |
| Race writes on the box answer "checked in or taken over" | The box no longer holds the lease (checked in, or the cloud took over). Check the event on the cloud; check out again if the box should be the writer |
| Checkout says "journal entries not yet on the cloud" | Fix the uplink and retry; continue only if those entries do not matter |
| Box log: `ignoring column(s) this schema does not have` / checkout result `peerSchema` ≠ `localSchema` | The box and cloud run different versions. It still works; update the older one before the event |
