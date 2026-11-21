# Bugfix: Google Sheets webhook URL leaked across events

## What happened

`packages/api/src/sheetsBackup.ts` cached the Google Sheets webhook URL in a
single process-wide variable for 60 seconds. `getWebhookUrl` takes an
`eventId` and reads `events.google_sheets_webhook_url` for that event, but
the cache ignored the argument: the first event to push within the TTL
primed the URL that every later event reused.

Two competitions on the same API process could therefore send card readouts
and registrations to the wrong spreadsheet.

This was independent of the Cloud Run scale-out work; it already misfired on
a single instance whenever two events were active.

## Why

The cache was added as a cheap skip of a one-row lookup on the hot readout
path. It was written as if Oxygen served one event per process, which was
true of the old MeOS-per-database layout and is not true of the single
`oxygen` schema.

## Fix

The cache is a `Map` keyed by event id. A miss still reads that event's
row; a hit for event A can never satisfy event B. `clearSheetsCache()`
(called when an operator saves a webhook URL) still drops the whole map.

## Tests

`packages/api/src/__tests__/sheets-backup.test.ts` covers distinct URLs,
cache reuse for the same event, and a missing webhook not inheriting
another event's cached URL.
