# Bugfix: runner directory sync timed out in the cloud

## Symptom

Updating the global Eventor runner database was much slower on the cloud
instance than locally. After several minutes the UI could fail with:

```
Failed to execute 'json' on 'Response': Unexpected token 'u',
"upstream r"... is not valid JSON
```

## Cause

The sync split approximately 200,000 runners into arrays of 1,000, but then
executed and awaited an individual Prisma `upsert` for every runner. It also
wrote clubs one at a time. Database network latency therefore dominated the
request and could exceed the Cloud Run request timeout.

When the request timed out, the proxy returned the plain-text body `upstream
request timeout`. The tRPC client attempted to parse that body as JSON, hiding
the actual failure behind a JSON syntax error.

## Fix

- Runner and club directory writes now use PostgreSQL
  `INSERT ... ON CONFLICT DO UPDATE` statements with up to 1,000 rows each.
- Duplicate Eventor IDs are collapsed before each import.
- Existing club logo columns are not touched by metadata upserts.
- Non-JSON gateway responses are classified before tRPC parses them, so a
  timeout is reported as a timeout.

The runner table is updated in place rather than deleted and rebuilt, so
lookups remain available throughout a sync.

## Tests

- Integration coverage verifies batched runner inserts/updates and preservation
  of club logos.
- Web unit and Playwright coverage verify plain-text timeout handling.
