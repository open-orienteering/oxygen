# Background jobs and the leader lease

Most of the Oxygen API scales horizontally without any coordination: every
request reads and writes Postgres, and two instances serving different
requests never need to agree on anything. Four pieces of background work
are the exception, because they are *not* driven by a request and they
have side effects outside the database:

| Job | Where | What goes wrong when two instances run it |
|-----|-------|-------------------------------------------|
| LiveResults push | `liveresults.ts` | Both push the same results to the same remote competition, on top of each other, on independent timers. |
| Online-input (ROC) polling | `online-input/puller.ts` | ROC de-dupes purely by a `lastId` watermark, so both consume the same punch range and insert duplicate `punches` rows. |
| Journal shipping | `sync/shipper.ts` | The same journal entries ship twice. Inert unless `SYNC_PEER_URL` is set, i.e. on a venue box. |
| Map storage GC | `map-store/gc.ts` | Nothing breaks — every delete re-checks its conditions — but the daily pass is meant to run once, not once per instance. See [map-storage.md](../map-storage.md) §8. |

Before this existed, every instance ran all three on boot, which is why
Cloud Run was pinned to `--max-instances=1`.

## How it works

One row in `oxygen.instance_lease` per named responsibility — today only
`background-jobs`. The holder renews `expires_at` every TTL/3; any
instance may take the lease over once it lapses. Acquire and renew are
the same statement, an upsert whose UPDATE is guarded by *"we already
hold it, or it has expired"*:

```sql
INSERT INTO oxygen.instance_lease AS l (name, holder_id, acquired_at, renewed_at, expires_at)
VALUES ($1, $2, now(), now(), now() + $3::double precision * interval '1 millisecond')
ON CONFLICT (name) DO UPDATE
   SET holder_id   = EXCLUDED.holder_id,
       renewed_at  = now(),
       expires_at  = EXCLUDED.expires_at,
       acquired_at = CASE WHEN l.holder_id = EXCLUDED.holder_id
                          THEN l.acquired_at ELSE now() END
 WHERE l.holder_id = EXCLUDED.holder_id
    OR l.expires_at <= now()
RETURNING holder_id;
```

No rows returned means somebody else holds it. A conflicting insert
serialises on the primary key, so instances starting in the same
millisecond cannot both win. Every timestamp is the database's `now()`,
so clock skew between instances cannot produce two holders.

`BackgroundSupervisor` (`background/supervisor.ts`) owns the lease and
reacts to it:

- **on acquiring** — reconcile immediately, then every
  `BACKGROUND_RECONCILE_MS` (default 5000).
- **on losing** (taken, unreachable database, or shutdown) — stop the
  reconcile loop and drop every local timer.

Failing to reach the database counts as losing the lease. We can no
longer prove we hold it, another instance will take over once ours
lapses, and two pushers is a worse outcome than a few seconds with none.

## Why a lease row and not `pg_advisory_lock`

A session-level advisory lock belongs to the connection that took it, and
Prisma hands out pooled connections per query. We could not guarantee
that a renewal ran on the connection holding the lock, nor notice when
the pool retired that connection — leadership would either drop silently
or leak until the process died. Holding it inside a long-lived
interactive transaction would fix the pinning and introduce a connection
sitting `idle in transaction` for the length of a competition.

A row with an expiry is pool-agnostic, and it answers an operational
question directly:

```sql
SELECT name, holder_id, acquired_at, renewed_at, expires_at
  FROM oxygen.instance_lease;
```

## Reconciling instead of starting timers directly

The tRPC mutations that enable or disable a push or a poller no longer
arm a timer. They write the configuration (`events.liveresultsConfig`,
`settings.online_input_<id>_config`) and call
`requestBackgroundReconcile()`, which is a no-op unless this instance
holds the lease. The holder's reconcile loop picks the change up within
one interval, so toggling a job on any instance works.

Two consequences worth knowing:

- **Reconciling must be idempotent, and it is a diff, not a restart.**
  Starting a pusher fires an immediate push, so blindly restarting every
  enabled event every 5 seconds would turn into a push every 5 seconds.
  A timer already armed with the right tavid and cadence is left alone.
- **Status has to come from the database.** The timer runs on one
  instance while the operator's status query can land on any of them, so
  `liveresults.getStatus` reports `running` from the configured intent
  and `lastPush` / `pushCount` / `lastError` from `settings`, written by
  the holder after each cycle. The online-input puller already worked
  this way.

The storage GC is not a timer: the holder's reconcile calls
`maybeStartStorageGc()`, which reads `map_storage_gc.started_at` /
`finished_at` from `settings` (at most every 15 minutes) and starts a
run in the background when the last one finished a day ago. Because the
schedule lives in the database, it survives restarts and leadership
changes, and two leaders under different `LEADER_LEASE_SCOPE`s on one
database (dev and Docker) still run it once a day between them. Losing
the lease asks a running GC to stop after its current row.

## Which node runs what

The lease picks one instance *within* a deployment. A venue box and the
cloud are two deployments with two databases, so the lease cannot keep
them apart; the node role does (`NODE_ROLE`, `sync/nodeIdentity.ts`):

| Job | Cloud (`NODE_ROLE` unset or `cloud`) | Venue box (`NODE_ROLE=venue`, ships to `SYNC_PEER_URL`) |
|-----|------|------|
| LiveResults push | yes, the one owner | never: the reconcile skips it and drops any timer (`publishesLiveResults()` in `background/supervisor.ts`); a standalone box with no peer pushes itself |
| ROC polling | yes | yes, into the box's own database (see [online-input-roc.md](online-input-roc.md)) |
| Journal shipping | inert (no peer) | yes |
| Map storage GC | yes | yes |

A box with an uplink pushing LiveResults beside the cloud would write the
same competition from two databases, and the lagging copy would undo the
other's rows each cycle (SYNC-14). The box's results reach LiveResults
through shipping: the cloud ingests them within a shipping interval and
its next cycle publishes them. On such a box, `liveresults.getStatus` returns
`pushedByCloud: true` and the event page says "Pushed by the cloud
server"; the push status itself lives in the cloud's database.

A soft-deleted event (`events.removed`) is neither pushed nor polled: both
reconciles skip it and stop a running timer, and its stored config is kept
so a restore resumes. `event.purgeDeleted` drops the event's
`online_input_<id>_*` and `liveresults_<id>_status` settings rows with it
(MC-28).

## One LiveResults cycle at a time

Each cycle reads the event, builds the rows the remote competition should
hold (`buildLiveResultsRows`, pure), reads what the remote holds in
Oxygen's scope, and writes only the difference in one MySQL transaction
(`pushLiveResultsRows`). Per event, the manager runs one cycle at a time:
a tick that finds the previous cycle still running is skipped, and a
manual `pushNow` waits for it and then runs. A cycle has a 2-minute
deadline and every statement a 15 s timeout; on a timeout or lost
connection the socket is destroyed (the server rolls the transaction back
once it notices) rather than rolled back behind the stalled statement, so the guard always
clears and `lastError` is set. `lastPush` is the start time of the last
successful cycle; a skipped tick changes no status. See
[bugfixes/liveresults-single-owner-and-incremental-push.md](../bugfixes/liveresults-single-owner-and-incremental-push.md).

## Defence in depth on the ROC watermark

The lease means one poller, but leadership does change hands, and
duplicate punches are not something an operator can unpick afterwards.
So the watermark advance is a compare-and-set inside the same
transaction as the punch inserts:

```sql
UPDATE oxygen.settings
   SET value = jsonb_set(value::jsonb, '{lastId}', to_jsonb($1::bigint))::text
 WHERE key = $2
   AND COALESCE((value::jsonb->>'lastId')::bigint, 0) = $3
```

A second poller that fetched the same range finds the watermark moved,
fails the compare, and rolls its inserts back. Updating only this key
also stops a poll from clobbering configuration an operator edited while
the fetch was in flight. The other direction is covered too: every
router write to the config row (`routers/onlineInput.ts`, `updateConfig`)
holds `SELECT … FOR UPDATE` for its read-modify-write, so the poll's
`UPDATE` waits for it and re-checks against the row it left, and a save
can never write an older `lastId` back. Punches already stored are
skipped by `punches_oi_dedup_idx` (`ON CONFLICT DO NOTHING`), so a reset
watermark re-reads the range without failing the batch.

## Lease scope in development

The dev servers and the local Docker stack share one database
(AGENTS.md §3), so without a distinguishing name starting Docker would
silently take the timers away from `pnpm dev`. `LEADER_LEASE_SCOPE`
suffixes the lease name; `docker-compose.host-db.yml` sets it to
`docker`. Instances that *should* elect a leader among themselves — the
Cloud Run revision — share one scope, which is why nothing sets it there.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `LEADER_LEASE_SCOPE` | *(unset)* | Suffix on the lease name. Set it for deployments that share a database but are not peers. |
| `BACKGROUND_RECONCILE_MS` | `5000` | How often the holder re-reads job configuration. Minimum 1000. |
| `DATABASE_POOL_MAX` | `25` | Connections per instance. With more than one instance this has to be divided down — see [ops/deploy-gcp-cloud-run.md](../ops/deploy-gcp-cloud-run.md) §Sizing. |

## Still process-local

Worth knowing when reasoning about a multi-instance deployment, none of
it a correctness problem:

- **Caches are per-instance** (parsed map SVGs, CRS, Eventor club member
  lists). They cost memory per instance and a lower hit rate, not
  wrong answers — the map SVG cache re-checks the map file's
  `uploadedAt`, because `onMapUpload` only fires in the process that
  handled the upload.
- **There is no server push.** Clients poll `event.counterState`, which
  is a database read, so they see another instance's writes on their next
  poll (~1–5s).
- **The hybrid logical clock in `serverClock.ts` is per process.** Its
  physical component is wall-clock, so ordering across instances is as
  good as their clock sync; the logical counter only breaks ties within
  a process. This matters only for journal entries written concurrently
  by two cloud instances.
- **Test Lab simulations** live in the memory of the instance that
  started them. The Test Lab works only on an event marked as a test event
  (`events.is_test_event`; every writing procedure answers
  `PRECONDITION_FAILED` / `NOT_A_TEST_EVENT` otherwise). It is not
  lease-managed and its writes are not journaled: a test event cannot be
  checked out to a venue (lease acquisition, which a venue checkout goes
  through on the cloud, refuses a test event), `event.setTestEvent` refuses an
  event that has an active lease, an Eventor link, or any runner, card, punch
  or card readout, and the Test Lab itself refuses an event that has since
  gained a lease or an Eventor link. A timed simulation checks
  the flag on every tick and halts when it is cleared (`event.setTestEvent`
  with `enabled: false` also stops it at once); ticks never overlap.
