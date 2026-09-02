# Background jobs and the leader lease

Most of the Oxygen API scales horizontally without any coordination: every
request reads and writes Postgres, and two instances serving different
requests never need to agree on anything. Three pieces of background work
are the exception, because they are *not* driven by a request and they
have side effects outside the database:

| Job | Where | What goes wrong when two instances run it |
|-----|-------|-------------------------------------------|
| LiveResults push | `liveresults.ts` | Both push the same results to the same remote competition, on top of each other, on independent timers. |
| Online-input (ROC) polling | `online-input/puller.ts` | ROC de-dupes purely by a `lastId` watermark, so both consume the same punch range and insert duplicate `punches` rows. |
| Journal shipping | `sync/shipper.ts` | The same journal entries ship twice. Inert unless `SYNC_PEER_URL` is set, i.e. on a venue box. |

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

## Defence in depth on the ROC watermark

The lease means one poller, but leadership does change hands, and
duplicate punches are not something an operator can unpick afterwards.
So the watermark advance is a compare-and-set inside the same
transaction as the punch inserts:

```sql
UPDATE oxygen.settings
   SET value = jsonb_set(value::jsonb, '{lastId}', to_jsonb($1::int))::text
 WHERE key = $2
   AND COALESCE((value::jsonb->>'lastId')::int, 0) = $3
```

A second poller that fetched the same range finds the watermark moved,
fails the compare, and rolls its inserts back. Updating only this key
also stops a poll from clobbering configuration an operator edited while
the fetch was in flight.

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
| `DATABASE_POOL_MAX` | `25` | Connections per instance. With more than one instance this has to be divided down — see [deploy-gcp-cloud-run.md](deploy-gcp-cloud-run.md) §Sizing. |

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
  started them. It is a development feature and is not lease-managed.
