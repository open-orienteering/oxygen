# Bugfix: Cloud SQL "handshake failed … EOF" after raising max instances

## Symptom

After a Cloud Run deploy, the log filled with:

```
Cloud SQL connection failed. Please see https://cloud.google.com/sql/docs/postgres/connect-run
for additional details: dial error: handshake failed
(connection name = "oxygen-skogsluffarna:europe-north1:oxygen-pg"): EOF
```

and Prisma reported:

```
PrismaClientKnownRequestError
  code: 'P2010'
  driverAdapterError: DriverAdapterError: DatabaseNotReachable
Raw query failed. Message: `Can't reach database server at /cloudsql/…`
```

The Cloud SQL instance looked completely healthy: state `RUNNABLE`, CPU
3–36%, no query errors, no `FATAL` beyond a single
`connection to client lost`.

The user-visible effect was a storm of `429 Too Many Requests` — including
on `/manifest.webmanifest` and `/api/version`, which are static and never
reach the application.

## Root cause

The connection budget for the `db-f1-micro` tier was exhausted, and a
shared-core instance at its connection ceiling **drops the connector's TLS
handshake instead of refusing the connection at the Postgres level**. The
failure therefore surfaces as `EOF` during the TCP/TLS handshake rather
than the `FATAL: sorry, too many clients already` the sizing notes had
predicted — which is exactly why the database looked innocent.

`db-f1-micro` allows `max_connections = 25` and reserves 3 for superuser
use, leaving ~22. With `DATABASE_POOL_MAX=10`, two instances already claim
20 of those 22. Peak `num_backends` was measured at **20**. The prior
configuration was thus arithmetically legal but had no headroom, and any
extra connection — the migration job, an interactive `psql`, or the
connector retrying — tipped it over.

The trigger was raising Cloud Run max instances from 2 to 10 in the
console, which permits `10 × 10 = 100` connections against a 22-connection
budget.

### Why the deploy script did not prevent it

Cloud Run has two independent max-instances settings:

| Setting | Where | Set by |
|---|---|---|
| `autoscaling.knative.dev/maxScale` | revision template | `gcloud run deploy --max-instances` |
| `run.googleapis.com/maxScale` | service annotation | `gcloud run services update --max` only |

The service-level value is divided across revisions and **wins when the two
disagree**. `gcloud run deploy` has no flag for it, so the console change
persisted through the deploy while every revision still reported
`maxScale: 2`:

```
run.googleapis.com/maxScale: '10'        # service — effective
  autoscaling.knative.dev/maxScale: '2'  # revision — misleading
```

### Cascade into 429s

1. Connector handshakes fail → Prisma `P2010`.
2. Requests block waiting for a pool slot. A trivial
   `permission.myCapabilities` call was observed taking **213 s**.
3. Requests hit the 300 s Cloud Run timeout → 82 responses of `504`.
4. Instances stay saturated, so Cloud Run stops admitting requests and
   returns `429` at the infrastructure layer — 296 of 1000 sampled
   requests, static assets included.

The 429s are a *consequence* of DB unreachability, not tile-endpoint load.
The client-side tile throttling added in
[map-tile-rendering.md](map-tile-rendering.md) is unrelated here.

## Fix

Restored the connection budget with headroom:

```bash
gcloud run services update oxygen --region=europe-north1 \
  --max-instances=2 --update-env-vars=DATABASE_POOL_MAX=8
gcloud run services update oxygen --region=europe-north1 --max=2
```

`2 × 8 = 16` of ~22 usable connections, leaving 6 for the migration job and
ad-hoc access.

`scripts/gcp/deploy.sh` now sets `DATABASE_POOL_MAX=8` and follows each
deploy with `gcloud run services update --max=2`, so the service-level cap
cannot drift away from the revision-level one unnoticed.

## Sizing rule

```
max_instances × DATABASE_POOL_MAX + 6 ≤ (max_connections − 3)
```

To scale out, raise the Cloud SQL tier **first** (`db-g1-small` allows 50),
then raise both numbers together.

## Diagnosing a recurrence

The instance metrics are the fast path — `num_backends` approaching
`max_connections − 3` while CPU stays low is the signature:

```bash
# Peak connection count over the last 4h
TOKEN=$(gcloud auth print-access-token)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://monitoring.googleapis.com/v3/projects/$PROJECT_ID/timeSeries?\
filter=metric.type%3D%22cloudsql.googleapis.com/database/postgresql/num_backends%22\
&interval.startTime=$(date -u -d '4 hours ago' +%Y-%m-%dT%H:%M:%SZ)\
&interval.endTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

Check whether Postgres ever refused a connection itself. If this is empty
while the connector logs `EOF`, the ceiling is being hit *below* Postgres
and you are looking at this bug:

```bash
gcloud logging read \
  'resource.type="cloudsql_database" AND textPayload=~"too many clients"' \
  --freshness=6h
```

Note that `memory/utilization` reads a constant `1.0` on shared-core tiers
and is not a useful signal; `memory/total_usage` (the real working set,
which peaked at 400 MiB of 614 MiB here) is the one to look at.
