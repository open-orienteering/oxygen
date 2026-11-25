# Registration, Readout & Kiosk Flow

This document describes the end-to-end flows for SI card registration, readout, and kiosk display. It covers the client-side device handling, server-side data processing, stale punch detection, and the BroadcastChannel-based kiosk protocol.

## Overview

```
SI Card Inserted
    │
    ▼
┌──────────────────────┐
│  Card readers (1..N) │  packages/web/src/lib/webserial.ts (USB, Web Serial)
│  (si:card-readout)   │  each implements SIReader (lib/si-reader.ts)
└─────────┬────────────┘
          │
          ▼
┌──────────────────────┐
│   ReaderHub          │  packages/web/src/lib/reader-hub.ts
│                      │  Fans every reader's si:* events into one stream
└─────────┬────────────┘
          │
          ▼
┌──────────────────────┐
│   DeviceManager      │  packages/web/src/context/DeviceManager.tsx
│   addRecentCard()    │  Central card processing pipeline
│                      │
│  1. DOW freshness    │  isPunchDataFresh() — client-side stale check
│  2. storeReadout()   │  Backup to DB + conditional oCard write
│  3. readout query    │  Fetch runner info + course matching
│  4. Action decision  │  "register" | "readout" | "pre-start"
│  5. Auto-apply       │  Write Status/FinishTime if readout
│  6. Kiosk broadcast  │  BroadcastChannel → KioskPage
└─────────┬────────────┘
          │
          ├──── action = "register" ──────▶ RegistrationDialog
          ├──── action = "readout"  ──────▶ Kiosk readout screen + guarded apply
          └──── action = "pre-start" ─────▶ Kiosk pre-start screen
```

## Key Files

| Component | File | Role |
|-----------|------|------|
| SI protocol | `packages/web/src/lib/si-protocol.ts` | Low-level SI card protocol (read/write/parse) |
| Reader contract | `packages/web/src/lib/si-reader.ts` | `SIReader` interface and status type shared by every transport |
| Reader hub | `packages/web/src/lib/reader-hub.ts` | Holds several readers, re-dispatches their events, aggregate status |
| Web Serial | `packages/web/src/lib/webserial.ts` | USB SI station connection, card read, station programming |
| Reader BT | `packages/web/src/lib/reader-bt/connection.ts` | SPORTident Reader BT over Web Bluetooth: GATT, card flow, auto-reconnect |
| Reader BT protocol | `packages/web/src/lib/reader-bt/protocol.ts` | Pure Reader BT message decoder/encoder (`docs/si-protocol/reader-bt.md`) |
| Reader dialog | `packages/web/src/components/ReaderConnectionDialog.tsx` | Lists readers, adds and disconnects them |
| DeviceManager | `packages/web/src/context/DeviceManager.tsx` | Card processing pipeline, action routing |
| Kiosk channel | `packages/web/src/lib/kiosk-channel.ts` | BroadcastChannel protocol for admin↔kiosk IPC |
| Kiosk page | `packages/web/src/pages/KioskPage.tsx` | Self-service kiosk display (readout, pre-start, registration) |
| Registration dialog | `packages/web/src/components/RegistrationDialog.tsx` | Runner registration form with autocomplete |
| Card readout router | `packages/api/src/routers/cardReadout.ts` | storeReadout, readout query, performReadout |
| Runner router | `packages/api/src/routers/runner.ts` | runner.create (links oCard), runner.update (auto-populate times) |

---

## 1. SI Card Read

### 1a. Readers and the reader hub

Oxygen can hold several card readers at once, and every one of them feeds the same pipeline. Each reader implements `SIReader` (`lib/si-reader.ts`): an id, a kind (`serial` or `ble`), a label, a status (`idle | connecting | connected | reading | error`), optional device info (serial number, firmware, model, operating mode) and `disconnect()`. A USB SI station is an `SIReaderConnection` (`lib/webserial.ts`); it learns its serial number, firmware, model and mode from the SYS_VAL block it already reads on connect. A SPORTident Reader BT is a `ReaderBtConnection` (`lib/reader-bt/connection.ts`, see "Bluetooth readers" below); it adds a battery percentage.

`DeviceManager` owns one `ReaderHub` (`lib/reader-hub.ts`) instead of one connection. The hub re-dispatches every reader's events:

| Event | Detail from the hub |
|-------|---------------------|
| `si:card-readout` | the reader's `SICardReadout`, untouched |
| `si:card-detected` | the detection plus `readerId` |
| `si:card-removed` | `{ readerId }` |
| `si:status` | `{ status, readerId, readerStatus }`, where `status` is the best status across all readers (reading > connected > connecting > error > idle) |
| `hub:readers-changed` | a snapshot of every reader, for the dialog |

Because `status` is the aggregate, everything that reads `readerStatus` from the context (Recent Cards, Card Readout, the kiosk) sees "live" while any reader is live. Station programming on the Controls page uses `serialStatus` instead, the aggregate over USB stations only, and `getReaderConnection()` returns the first USB station.

**Connecting.** The header pill (and the kiosk's reader button in standalone mode) opens the reader connection dialog. It lists every reader with its status, serial number, firmware and the time of its last card, warns when a station is not in readout mode, and has a **USB station** button that opens the browser's serial picker and a **Bluetooth Reader BT** button (`connect-reader-bt`) that opens the Bluetooth picker. The Bluetooth button is disabled, with the reason underneath, when the browser has no Web Bluetooth (Chrome on desktop Linux only exposes it with `chrome://flags/#enable-experimental-web-platform-features`, and the dialog says so there), when the page is not a secure context (plain `http://<venue-box>:8080` is not; HTTPS and localhost are), or when `getAvailability()` reports no adapter. A collapsible help section explains how to wake a Reader BT. The dialog closes after a successful connect. Cancelling a picker leaves nothing behind. On page load DeviceManager reopens *every* port the origin was granted before, not only the first.

**Bluetooth readers.** `ReaderBtConnection` speaks the Reader BT GATT protocol (`docs/si-protocol/reader-bt.md`) over Web Bluetooth only (Chrome/Edge on desktop and Android):

- *Connect* — `gatt.connect()`, discover the Settings, Card readout and Battery services by UUID (never cached), subscribe to read settings, card state and card data, then ReadDeviceInfo (serial, firmware), ReadAllSettings (operating mode; the row warns when it is not Readout) and the battery level, which is followed by notification. Every GATT operation runs through one queue, because Web Bluetooth rejects concurrent operations.
- *Card flow (pull)* — CardStateChange "in" → `si:card-detected` → write a 0x1103 request → the (segmented) complete readout → `toSICardReadout` → **Feedback OK** written → `si:card-readout`. Feedback is the reader's two beeps, the Bluetooth counterpart of the serial ACK; it is sent as soon as the card decodes and never waits for `storeReadout`. A missing response (3 s) or a decode error is retried once, then Feedback error (five beeps on firmware 2.2.0) is written; a card pulled out before the readout completes fails it immediately, with the error beeps right away. CardStateChange "out" → `si:card-removed`. A card-data notification nobody asked for (AUTOSEND on) is handled the same way with a synthesised detection.
- *Reconnect* — a Reader BT that loses its link (out of range, interference, the page reloaded) goes to sleep and advertises again only when the next card is inserted, so Oxygen waits for that card for as long as the page is open: the row shows "Connection lost" (or "Waiting for the reader" for a remembered reader) with the hint to insert a card. Under the hood it first tries a direct `gatt.connect()` (capped at 5 s), then watches for the reader's advertisements where the browser supports it **and** tries `gatt.connect()` every 2 s (every 10 s after five minutes). A connect to a silent reader fails at once, so the poll is cheap, and on Linux Chrome, where advertisements never reach the page, it is what reconnects. The woken reader reports the card that woke it, so that card is read out without re-inserting; the whole thing takes 5–8 s from the insert on Linux. Each `gatt.connect()` is abandoned after 8 s because a connect to a sleeping reader may hang; service discovery after a successful connect is not capped. A manual Disconnect or Forget stops the wait; after a manual Disconnect the row offers **Reconnect**, which runs the same sequence.
- *Linux hosts* — Chrome on desktop Linux needs `chrome://flags/#enable-experimental-web-platform-features` for Web Bluetooth at all, and BlueZ needs a longer LE supervision timeout than its 420 ms default or the link drops after a few quick readouts (the reader's own request for 6 s is refused by the kernel): add `[LE]` / `ConnectionSupervisionTimeout=600` to `/etc/bluetooth/main.conf` and restart the `bluetooth` service. Verified with `btmon`: new links then come up with a 6000 ms timeout. See `docs/si-protocol/reader-bt.md`, "Hardware findings".
- *Page reload* — reloading drops the Bluetooth link (Chrome releases it about 2 s after unload), so after a reload the remembered reader shows "Waiting for the reader" until the next card is inserted.
- *Remembering* — every Reader BT added through the picker is stored in `localStorage["oxygen-reader-bt-devices"]` (`{id, name, lastSeen}`). On page load DeviceManager takes the granted devices from `navigator.bluetooth.getDevices()` that are in that list, adds them as "Waiting for the reader", and connects each the same way: directly if the link is still up, otherwise when it advertises. **Forget** drops the reader from the list and calls `device.forget()`, revoking the browser's permission. Where `getDevices()` is missing the reader has to be added again through the picker after a reload.
- *Debugging* — `localStorage.setItem("oxygen-si-debug", "1")` logs every notification and write with a `[ReaderBT]` prefix, as it does `[SI]` for USB stations.

Nothing needs adding to the deployment: no `Permissions-Policy` header is set today. A future one must allow `bluetooth=(self)` and `serial=(self)`.

**Kiosk with several readers.** Only the reader that reported the most recent card insert may clear the kiosk's "do not remove the card" screen, so lifting a card from one reader does not cancel a readout in progress on another.

### 1b. Card events

When an SI card is inserted into a connected reader, the reader reads the card data and emits events:

1. **`si:card-detected`** — Card physically detected (before data is read). Carries the card number.
2. **`si:card-readout`** — Full card data read. Carries an `SICardReadout` object:

```typescript
interface SICardReadout {
  cardNumber: number;
  cardType: "SI5" | "SI6" | "SI8+" | "SI9" | "SI10" | "SIAC" | ...;
  checkTime?: number;           // seconds since midnight
  startTime?: number;           // seconds since midnight
  finishTime?: number;          // seconds since midnight
  clearTime?: number;           // seconds since midnight
  finishDayOfWeek?: number;     // 1=Mon..7=Sun (from PTD byte)
  checkDayOfWeek?: number;      // 1=Mon..7=Sun
  punches: { controlCode: number; time: number }[];
  punchCount: number;
  ownerData?: { firstName, lastName, sex, dateOfBirth, club, phone, email, country };
  batteryVoltage?: number;      // volts (SIAC only)
  metadata?: { batteryDate, productionDate, hardwareVersion, softwareVersion, clearCount };
}
```

3. **`si:card-removed`** — Card physically removed from the reader.

Supported card types: SI5, SI6, SI8, SI9, SI10, SI11, SIAC, pCard, tCard.

---

## 2. DeviceManager Pipeline

`DeviceManager` is a React context that manages SI reader connections and processes all card events. The main processing function is `addRecentCard(readout)`, triggered by `si:card-readout`.

### 2a. Deduplication

A re-read is a duplicate (`findDuplicate` in `lib/offline/readout-policy.ts`) only when an earlier entry in the recent-cards list has identical data (`readoutsMatch()`: card number, start/finish/check times, punch sequence), was taken in the **same event** (`competitionId`, from the URL), and was **persisted**, that is stored on the server or queued in this device's outbox. There is no time window. A duplicate reuses the entry ID and is not stored again, but its action is still re-resolved (the runner may have been registered meanwhile).

A read whose store or queue write is still in flight (`saveState: "saving"`) also counts as a duplicate, so a re-insert during a slow save is not queued twice. A read that reached neither the server nor the outbox (`saveState` `not-saved` or `no-competition`) is never a duplicate: the next insert of the same card tries again and replaces the failed entry. The same card data in another event is a new read.

### 2b. Client-Side Freshness Check

```typescript
function isPunchDataFresh(readout: SICardReadout): boolean
```

SI cards retain punches from previous races until explicitly cleared. The day-of-week (DOW) byte in the card's PTD field encodes which day the punches were recorded. If the finish or check DOW doesn't match today, the data is stale.

- Extracts DOW from `finishDayOfWeek` or `checkDayOfWeek` (SI format: 1=Mon..7=Sun)
- Compares against today's DOW (converted from JS format: 0=Sun..6=Sat)
- Returns `false` if DOW mismatch → punches are from a different day

The result is stored as `hasRaceData` on the card entry and passed to the server as `punchesFresh`.

### 2c. Store Readout (Server Call)

The readout is always sent to the server via `storeReadout`:

```typescript
storeReadout.mutateAsync({
  cardNo,
  punches: [{ controlCode, time }],     // times in seconds
  checkTime, startTime, finishTime,       // seconds since midnight
  cardType, batteryVoltage,               // integer mV (meosFromVolts of the readout's volts)
  punchesFresh: boolean,                  // from isPunchDataFresh()
  ownerData: { firstName, lastName, ... },
  metadata: { batteryDate, clearCount, ... },
})
```

The server always backs up the data to `oxygen_card_readouts` (forensic history), but only writes to `oCard` (the MeOS-compatible table) if strict guards pass. See §3 below.

#### 2c-1. When the server is unreachable or too slow

The event is the first path segment of the URL (`activeEventNameId()`, the same source as the `x-competition-id` header), so the standalone kiosk and start screens, which sit outside `CompetitionShell`, queue under the right event. `storeReadout` is capped at 8 s; the call failing, timing out or the browser being offline all take the same path:

1. `card.read` is written to the local outbox (`emitEvent`, awaited). Success sets `saveState: "queued"`. If there is no event in the URL, or IndexedDB refuses the write, nothing was saved: `saveState` is `no-competition` or `not-saved`, `persisted` stays false, and the standalone kiosk shows a red notice ("Card was not saved. Insert it again.").
2. The server fetch of §2d is skipped when the server was unreachable or too slow. If it answered with an error (a kiosk key refused for writes, a lease refusal), the fetch still runs: the kiosk key may call `cardReadout.readout`. The result is computed locally from the cached runner list and dashboard (`computeCardReadout`), which only reads a cache that belongs to this event (§2c-3).
3. If a runner is found, `result.applied` is queued too (awaited, failure logged). It is queued only when `canApplyResults(authEnabled, signedIn)` holds, i.e. auth is off (venue box) or an operator is signed in. A device that has only a kiosk key (auth on, nobody signed in) queues `card.read` alone: it stays display-only for everything but its own readout entries (decision D11).

#### 2c-2. Draining

The kiosk route mounts its own `useEventQueue(nameId)` and shows `data-testid="kiosk-sync-badge"` while entries are pending or rejected. A refusal from the server (`UNAUTHORIZED` / `FORBIDDEN`, a kiosk-key-only device under auth) is not a network error: entries stay pending and the badge reads "saved on this device. An operator must sign in to send them". Nothing widens what a kiosk key can call; `storeReadout`, `applyResult` and `events.push` still need a signed-in user.

#### 2c-3. The cache belongs to one event

Event-scoped tRPC queries have `undefined` input, so their query keys do not name the event. The persisted query cache therefore has an owner (marker query `["oxygen","cacheOwner"]`) and one IndexedDB blob per event (`oxygen-query-cache:<nameId>`; `lib/offline/cache-scope.ts`, `persister.ts`). `CompetitionShell`, `KioskPage` and `StartScreenPage` call `ensureEventCache` before selecting the event: it flushes the outgoing event's blob, clears the queries (never the mutation cache), and loads the incoming event's blob if there is one. Switches are last-caller-wins (an overtaken switch leaves the cache alone), persistence is suspended during the swap, queries a mounted component observes are reset in place and refetched (never removed from under their observer), and user queries (`users.*`) stay live and are kept out of event blobs. The owner marker never expires (`gcTime: Infinity`). A page outside any event (the event selector) restores the blob persisted last (a pointer key `last-owner`), so its shared queries are as fresh as the last event page left them. An event never opened on this device starts empty offline. Local readout lookups read only exact-key, no-input queries (a filtered `runner.list({search})` is never taken for the full list) and return nothing if the cache owner is not the event being read. The cache of earlier versions had no owner and is dropped on first load: stations re-warm once while online.

### 2d. Fetch Readout Data

After storing, DeviceManager fetches the runner's full readout via `cardReadout.readout({ cardNo })`. This returns:

- Whether a runner was found for this card number
- Course matching results (punch-by-punch comparison against expected controls)
- Timing data (start, finish, running time, status)
- `punchesMatchCourse` flag (server-side course matching)

### 2e. Action Determination

Based on the DB lookup result:

| Condition | Action | Meaning |
|-----------|--------|---------|
| No runner found for this CardNo | `register` | New runner — open registration dialog |
| Runner found, punches match course OR has existing result | `readout` | Show result on kiosk, apply under the guards (§2f) |
| Runner found, no matching punches, no existing result | `pre-start` | Runner is registered but hasn't raced yet |

"Has existing result" means `Status > 0` excluding DNS (20) and Cancel (21), which are pre-race statuses.

### 2f. Apply the Result (guarded)

When action is `readout`, DeviceManager asks the server to write the result:

```typescript
applyResult.mutateAsync({
  runnerId,
  status,        // numeric RunnerStatus
  finishTime,    // absolute deciseconds
  startTime,     // absolute deciseconds
  punchesFresh,  // the client freshness verdict (§2b)
  confirmed,     // true only after the operator accepted a held read
})
```

The server runs one guard, `decideReadoutApply` (§3a), and answers with `{ ok, outcome, reason }`:

| `outcome` | Meaning |
|-----------|---------|
| `applied` | The runner row changed; `result.applied` is journaled. |
| `unchanged` | Same values already stored; nothing written, nothing journaled. |
| `needsConfirmation` | The read would replace the stored result with a worse one. Nothing is written; the operator is asked (banner `apply-hold-banner`, "Replace result" / "Keep result"). |
| `protected` | The stored result is a DQ or hand-set; nothing is written, even when confirmed. The operator changes it on the runner. |

The assigned (draw) start time takes priority over the card start punch — the card punch is only used for punch-start events where no draw start is assigned.

**Latest card wins on screen (SI-17).** Each read mints an id and stores it in `latestCardIdRef`. After any await, the pipeline updates `currentCard` only while that card is still current (`nextCurrentCard`) and broadcasts to the kiosk only while it is the latest (`isLatestCard`). A slow earlier card still stores, applies and updates the recent list.

### 2g. Kiosk Broadcast

If a kiosk window is paired (same competition), DeviceManager sends the card data via BroadcastChannel and, after every online apply attempt (written, held or protected), a `readout-applied` message (not sent on the offline path). The kiosk then refetches `cardReadout.readout`, `runner.findByCard` and `race.finishReceipt`. The kiosk never writes a finish itself (WEB-72): it has no `race.recordFinish` call. See §7 for the kiosk protocol.

---

## 3. Server: storeReadout

**File:** `packages/api/src/routers/cardReadout.ts`

This is the core mutation that processes incoming card data on the server.

### 3a. Build MeOS Punch String

Input times (seconds since midnight from SI reader) are converted to ZeroTime-relative deciseconds before encoding in MeOS's string format:

```
Format: "{type}-{relativeSeconds}.{tenths};"

Input: SI card time 36120s (10:02:00), ZeroTime 32400s (09:00:00)
Relative: 36120 - 32400 = 3720s → "41-3720.0;"

Examples (with ZeroTime = 09:00:00):
  3-3540.0;     → check punch at 09:59:00
  1-3600.0;     → start punch at 10:00:00
  41-3720.0;    → control 41 at 10:02:00
  2-4320.0;     → finish punch at 10:12:00
```

Special punch types: `1` = start, `2` = finish, `3` = check. All other numbers are control codes.

### 3b. Foreign Control Check (Stale Detection Layer 2)

The server fetches all control codes defined in the current competition (`oControl.Numbers`) and counts how many of the card's punches are "foreign" (not in any competition control). A ratio-based check determines relevance:

```
foreignCount = punches with control codes NOT in competition
punchesRelevant = foreignCount <= 50% of total punches
```

This is deliberately generous — a single misconfigured control or accidental punch of a non-competition control won't invalidate the entire readout. The three-layer detection (DOW check + this + course matching) ensures stale data is still caught. Completely stale cards from different events will have a majority of foreign controls and be rejected.

### 3c. Backup to History Table

Every readout — stale or fresh — is saved to `oxygen_card_readouts` (raw SQL table, not Prisma). This provides a forensic record of every card scan, useful for post-race debugging. Deduplication: if the most recent entry for this card has identical punch data, the existing row is updated rather than inserting a duplicate.

### 3a-guard. Applying a result: the guards

`packages/shared/src/readout-guard.ts` (`decideReadoutApply`) is the one decision, used by `applyResult`, `pushReadoutBackup` and the offline `result.applied` ingest (`applyResultGuarded` in `cardReadout.ts`). Rules, in order:

1. **DQ is never overwritten**, not even when confirmed.
2. **A hand-set status** (`runners.status_manual`, set by `runner.update`, the status buttons and bulk DNS, only when the value really changes) is protected. A hand-set DNS, Cancel or Not competing asks instead, since the runner may have started after all.
3. **A hand-keyed finish** (`runners.finish_manual`, set by the Finish Station, `finish.recorded`/`finish.adjusted` and a changed `finishTime` in `runner.update`) is kept: `performReadout` uses it when the card has no finish punch (SI-10), and the guard never replaces it with a card's finish.
4. **A worse read asks** (`needsConfirmation`): the reader says the punches are not fresh (even when the runner has no result yet, so last week's punches never write times), or the runner has a result and the new read has no finish. `confirmed` lets it through.
5. **Identical values** are `unchanged` and checked first (a re-read that agrees with the stored result never asks and writes nothing).

**The card row is held too.** `storeReadoutImpl` always logs the read in `card_readouts`, but when the runner already has a result and the read is empty (cleared hire card), not fresh, or has no finish, `cards.punches_raw` keeps the earlier punches and `storeReadout` returns `cardHeld: true`. The evaluation then reproduces the stored result, so such a read is `unchanged` and does not ask. A held read is only in the readout log; to replace the result with it, correct the runner by hand. `performReadout` reports the stored status for a DQ or hand-set result, so receipts and the kiosk show what the runner has.

**Known gap:** a hand-keyed finish wins over a finish punch in the stored result, while the readout view still times the runner from the punch; the operator corrects the finish on the runner (documented in the bugfix note).

**Offline.** The queued `result.applied` goes through the same guard on ingest. An entry without `confirmed: true` that the guard holds is not applied (the entry stays in the journal); the server's own journaled entries carry `confirmed: true` because the decision was made there. Consequence: a held read that arrives only through the offline queue is not prompted to anyone; the card detail shows the stored result, and re-reading the card online asks.

### 3d. oCard Write Guards

> Historical (MeOS era): §3d–§3f describe the retired oCard layer. The current rule is §3a-guard above; a full rewrite of §3 is RES-28.

Three conditions must ALL be true to write to `oCard`:

```
shouldWriteOCard = punchesRelevant        // no foreign controls (§3b)
                && hasControlPunches       // punches.length > 0
                && punchesFresh !== false   // client DOW check passed (§2b)
```

If any guard fails, the readout is backed up to history but `oCard` is untouched. This prevents registration scans, stale data, and empty cards from polluting the MeOS-compatible `oCard` table.

Coverage of edge cases:

| Scenario | punchesRelevant | hasControlPunches | punchesFresh | oCard written? |
|----------|----------------|-------------------|-------------|----------------|
| Stale card, different course | false | true | varies | No |
| Stale card, same course, different DOW | true | true | false | No |
| Empty/cleared card | true | false | varies | No |
| Registration scan (card not cleared, same DOW) | true | true | true | Yes (rare edge case) |
| Post-race readout with valid punches | true | true | true | Yes |

The "same course, same DOW" edge case is extremely rare (requires the exact same course to be reused on the same weekday) and is overwritten by the real readout later.

### 3e. Prefer Runner-Linked oCard

When updating an existing oCard, the server prefers the one linked to the runner via `oRunner.Card` FK:

```
1. Look up runner by CardNo
2. If runner has Card FK → use that oCard
3. Else → findFirst by CardNo (non-removed, then any)
```

This prevents the wrong oCard from being updated when multiple rows exist (e.g., one from Oxygen, one from MeOS).

### 3f. ReadId Deduplication

Before writing, a hash is computed from the punch data:

```typescript
function computeReadId(punches, finishTime, startTime): number {
  // MeOS-compatible hash (SICard::calculateHash)
  let h = (punches.length * 100000 + (finishTime ?? 0)) >>> 0;
  for (const p of punches) {
    h = (((h * 31 + p.controlCode) >>> 0) * 31 + p.time) >>> 0;
  }
  return (h + (startTime ?? 0)) >>> 0;
}
```

If the existing oCard's `ReadId` matches the computed hash, the update is skipped (identical data already stored). This matches MeOS's deduplication behavior.

### 3g. Runner Linking

After creating or updating an oCard, if a runner exists with the same CardNo but has no `Card` FK set, the server links them:

```
oRunner.Card = oCard.Id
```

This happens on both the create and update paths, ensuring the FK is always set when possible.

### 3h. Return Value

```typescript
{ cardId: number | null, created: boolean, punchesRelevant: boolean }
```

- `cardId`: the oCard row ID (null if oCard write was skipped)
- `created`: true if a new oCard was created (vs. updated)
- `punchesRelevant`: whether punches passed the foreign control check

---

## 4. Server: Readout & Split Time Computation

### 4a. readout Query

```typescript
cardReadout.readout({ cardNo }) → { found: boolean, runner, timing, controls, ... }
```

Finds a runner by CardNo, then calls `performReadout()` to compute the full result.

### 4b. performReadout()

**Exported from `cardReadout.ts`**, used by multiple routers (race, runner, cardReadout).

Steps:

1. **Load runner** → get Class, Course assignment
2. **Load course** → get expected control sequence: the runner's own
   course (`runner.courseId` — her variant of a forked course) before the
   class's. A runner is validated against her own variant only; another
   variant's run is a mispunch (`course-controls-and-matching.md` "Forked
   courses and variants")
3. **Load card data**:
   - Prefer runner-linked oCard (`oRunner.Card` FK)
   - Fall back to CardNo lookup
   - Also load free punches (`oPunch` records from radio controls)
4. **Parse punches** from MeOS string format:
   ```
   "41-36120.0;42-36240.0;2-36720.0;" → [{type:41, time:361200}, {type:42, time:362400}, ...]
   ```
   Times are converted from `seconds.tenths` to deciseconds.
5. **Merge and sort** card punches + free punches by time
6. **Match to course** via `matchPunchesToCourse()`

### 4c. matchPunchesToCourse Algorithm

Sequential matching of actual punches against expected course controls:

```
Input:  allPunches (sorted by time), courseControls (expected order), fallbackStartTime
Output: matches[], extraPunches[], startTime, finishTime, missingCount

For each expected control:
  Scan forward through remaining punches
  If matching code found → status: "ok", record split/cumulative times
  If not found → status: "missing"

Extra = punches not consumed by any expected control
```

Start time priority:
1. **Assigned start** (from draw) — always preferred
2. **Card start punch** — used only if no assigned start (punch-start events)
3. **0** — if neither available

Split times are computed relative to the previous matched control (or start for the first control).

### 4d. Result Status Determination

Base status (computed from punch data):

```
finishTime === 0        → DNF (Did Not Finish)
missingCount > 0        → MP  (Missing Punch)
runningTime > 0         → OK
else                    → keep existing DB status
```

MeOS-compatible status overrides (applied only when base status is OK):

```
class.MaxTime > 0 AND runningTime > MaxTime  → OverMaxTime (6)
runner.TransferFlags & 256 (OutOfCompetition) → OutOfCompetition (15)
class.NoTiming OR runner.TransferFlags & 512  → NoTiming (2)
```

Priority: MaxTime > OutOfCompetition > NoTiming. If MaxTime is exceeded, the runner gets OverMaxTime regardless of flags. OutOfCompetition takes priority over NoTiming.

- **OverMaxTime**: Class-level setting (`oClass.MaxTime`, deciseconds). Runner's time is shown but they rank last.
- **NoTiming**: For children's/open classes. Set at class level (`oClass.NoTiming`) or per-runner (`TransferFlags` bit 512). Time is not displayed in results, runner is not placed.
- **OutOfCompetition**: Per-runner flag (`TransferFlags` bit 256). For course setters, unofficial runs. Time IS shown but runner is not placed.

### 4e. Return Object

```typescript
{
  runner: { id, name, cardNo, startNo, clubName, className, dbStatus },
  course: { id, name, length, controlCount },
  timing: {
    cardStartTime,          // from SI card start punch (deciseconds)
    assignedStartTime,      // from draw (deciseconds)
    startTime,              // effective (assigned > card > 0)
    finishTime,             // deciseconds
    runningTime,            // finish - start (deciseconds)
    status,                 // 1=OK, 2=NoTiming, 3=MP, 4=DNF, 6=OverMaxTime, 15=OutOfCompetition
  },
  controls: [{              // one per expected control
    controlCode, status,    // "ok" | "missing"
    punchTime, splitTime, cumTime,
  }],
  extraPunches: [...],      // punches not in course
  missingControls: [...],   // control codes with status "missing"
  isRentalCard: boolean,
  hasCard: boolean,
  otherVariantMatches: [{   // §4f; [] unless MP in a class pooling ≥ 2 variants
    courseId, variantKey, courseName,
  }],
}
```

### 4f. Another variant matched (red exit)

A runner in a class on a forked course runs **her own pre-set variant**
(§5c): the readout never chooses one, so a runner who followed another
fork is a mispunch like any other (user answer 3, 2026-11-07 — "it must
be pre-set, if not someone could just follow another runner"). The same
answer asks that it be easy to see when such a runner has in fact run
another fork completely, and to accept that at the red exit by hand.

- **Detection.** When the computed status is MP and the runner's class
  has a stage-0 pool of two or more variants, `performReadout` matches
  the punches against every other pooled variant with the shared pure
  `findMatchingVariants(punches, candidates, { fallbackStartTime })`
  (`packages/shared/src/readout.ts`, over `matchPunchesToCourse`, each
  candidate under its own `orderMode`) and returns the ones the punches
  validate **fully** against in `otherVariantMatches` — no required
  position missing (`missingCount === 0`; skipped positions never count,
  exactly the MP rule) and at least one position. A loop course may list
  several (a free-order loop matches every visiting order); a near miss
  is not listed — it is an ordinary mispunch for the official to judge
  with the punch table. Status, course and every other field stay the
  runner's own. Every reader of `performReadout` carries it: `readout`
  (the kiosk's source), `readoutByRunner`, the receipts. An OK read and a
  plain class cost nothing extra; an MP read resolves each other variant's
  positions with one query apiece — fine for a butterfly, a batched
  resolver if relay-sized pools (stage > 0, not F's) ever read here.
- **Offline.** `computeCardReadout` (`lib/offline/local-readout.ts`) runs
  the same helper over the dashboard cache: class rows carry
  `coursePoolIds` (the pool's course seqs in key order) and course rows
  `variantKey`. Its result feeds the DeviceManager's offline kiosk
  broadcast, which shows no banner (the kiosk never does); the desk pages
  render the banner from their `readout` / `readoutByRunner` query data,
  so offline it shows for a read still in the query cache, with the
  button disabled.
- **The desk.** The Runners page's expanded row (`RunnerInlineDetail`,
  above the punch table) and the readout-station page (`CardReadout.tsx`,
  before the mispunch map) show the banner `readout-other-variant` —
  "Punches match variant **B** (Lång B) completely" — with one button per
  match, **Accept variant B** (`readout-accept-variant`), which calls
  `cardReadout.acceptVariant` (§5c). Offline the banner shows and the
  button is disabled ("Needs the server").
- **The kiosk** is the runner's screen: it shows MP as before plus one
  line, "See the official at the readout desk" (§7d). It never accepts.

Nothing in timing switches a variant automatically; the accept is one
manual, journaled action per runner.

---

## 5. Runner Create & Update

### 5a. runner.create — oCard Linking

**File:** `packages/api/src/routers/runner.ts`

When a new runner is created with a CardNo, the server checks if an oCard already exists for that card (e.g., from a prior `storeReadout` during the scan) and links it:

```
IF input.cardNo > 0:
  existing = oCard.findFirst({ CardNo, Removed: false })
  IF found → oRunner.Card = existing.Id
```

This ensures the FK is set at registration time, even if the card was scanned before the runner was created.

**Who may register.** `runner.create` needs `race.operate` (Race crew), the same
capability a station's queued `runner.registered` needs through `events.push`;
`runner.update`, `bulkUpdate` and `delete` stay `event.manage` (Event admin). The
input still carries `status`, `finishTime` and the fee fields (`fee`, `paid`,
`payMode`, `cardFee`): race crew can already set a result through `applyResult` /
`recordFinish`, and the registration desk has to record payment, so nothing is
stripped for them. See [authentication.md](authentication.md#journal-push).

### 5b. runner.update — Auto-Populate Times on Status→OK

When an admin manually changes a runner's status to OK (e.g., correcting a DNF), the server automatically derives StartTime and FinishTime from the runner's oCard:

```
IF status changed to OK:
  IF StartTime === 0 OR FinishTime === 0:
    result = performReadout(client, runnerId)
    IF result.timing.finishTime !== 0:
      Fill missing StartTime and/or FinishTime from readout
```

This prevents the situation where a runner is marked OK but has no placement because times are zero.

### 5c. `courseId` — the runner's variant

`runner.create` and `runner.update` accept `courseId` (a course seq):
the runner's variant in a class whose course is a root with variations,
pre-set **before the race** (user answer 3, 2026-11-07). It must be one
of the class's pooled variants, else `PRECONDITION_FAILED`
`VARIANT_NOT_IN_POOL`. A create without it in a pooled class is dealt the
least-populated variant; a class change clears it and deals one of the
new class's pool; `courseId: null` asks for a new deal. The pick travels
in the journal as the seq (`runner.registered.courseId`,
`runner.updated.fields.courseId`) so a peer never re-picks; a station
registration without one is dealt by the writing node on ingest, which
journals its pick after the entry. Dealing a whole class is
`class.distributeVariants`. The full rule and its seams:
`course-controls-and-matching.md` "Forked courses and variants".

`storeReadout`'s relevance score (§3) likewise scores the punches against
the runner's own course before the class's.

**The desk's accept** (red exit, §4f): `cardReadout.acceptVariant
{ runnerId, courseId }` (race-operate, lease-gated) switches a runner to
another pooled variant her punches validate fully against. It refuses,
with `PRECONDITION_FAILED` and nothing written, a course outside the
class's pool (`VARIANT_NOT_IN_POOL`, also for a class without one), the
runner's current course (`VARIANT_IS_CURRENT`), and a variant the
punches do not validate fully against, or a run without a finish or a
start (no running time) (`VARIANT_NOT_MATCHED`). The check is the
re-run readout's computed status — not MP, with a finish and a running
time — so a missing NoTiming-leg control refuses exactly as it keeps the
variant out of `otherVariantMatches`. Otherwise, in one transaction: `runner.courseId`
= the variant; `performReadout` re-run on the transaction client; status,
start and finish written from it as `applyResult` writes them; journaled
`runner.updated { cardNo, runnerId, fields: { courseId: <seq>,
variantAccepted: true } }` then `result.applied { cardNo, runnerId,
status, finishTime, startTime }`. `variantAccepted` is informational — a
peer replays `courseId` through `buildRunnerUpdateData`, which ignores
it, and the `result.applied` carries the status. Results, splits, the
start list (`variantKey`), the kiosk's next read and the Eventor export
read the new course by construction.

---

## 6. Stale Punch Detection (Three Layers)

SI cards retain punches from previous races until explicitly cleared. Oxygen uses three independent layers to detect stale data:

```
Layer 1: Client DOW Check          Layer 2: Foreign Control Check       Layer 3: Match Score
(DeviceManager)                    (storeReadout server-side)           (readout query)

isPunchDataFresh()                 Compare punch codes against          computeMatchScore()
                                   oControl table
Extracts day-of-week from                                              Scores 0.0–1.0: course
SI card PTD byte.                  If MAJORITY of punches are           match rate minus foreign
If DOW ≠ today/yesterday           foreign → not relevant.              punch penalty (0.10 each).
→ stale.                           Tolerates a few foreign              Score ≥ 0.2 → readout.
                                   punches (misconfigured               Score < 0.2 → pre-start.

Catches: Stale data from           Catches: Stale data from             Catches: Coincidental
2+ days ago. Accepts               different competitions.               overlap, low match rate.
yesterday for night-O.             Tolerates minority foreign.

Result: punchesFresh               Result: punchesRelevant              Result: matchScore (0–1)
(passed to storeReadout)           (guards oCard write)                 (determines readout vs pre-start)
```

All three layers work independently. A card must pass all applicable checks to be treated as a valid readout. The scoring approach ensures that a single misconfigured control or accidental punch doesn't invalidate an entire readout, while completely stale cards from different events are still rejected.

---

## 7. Kiosk Protocol

### 7a. Architecture

The kiosk runs in a separate browser window (or tab) displaying a self-service screen for runners. It communicates with the admin window via the BroadcastChannel API — no network required, works even offline.

```
┌─────────────────┐     BroadcastChannel      ┌──────────────────┐
│  Admin Window    │ ◄══════════════════════► │  Kiosk Window     │
│  (DeviceManager) │  "oxygen-kiosk-{nameId}" │  (KioskPage)      │
│  (RegDialog)     │                           │                   │
│  (CompShell)     │                           │                   │
└─────────────────┘                            └──────────────────┘
```

Channel name: `oxygen-kiosk-{competitionNameId}` — scoped to a specific competition.

### 7b. Message Types

| Message | Direction | When | Payload |
|---------|-----------|------|---------|
| `card-reading` | Admin → Kiosk | Card physically detected | `{ cardNumber }` |
| `card-readout` | Admin → Kiosk | Card fully read, action determined | `{ card: { action, runnerName, status, runningTime, ... } }` |
| `card-removed` | Admin → Kiosk | Card removed from reader | — |
| `registration-state` | Admin → Kiosk | Form data changed (heartbeat, every 2s) | `{ form: { name, className, ... }, ready }` |
| `registration-complete` | Admin → Kiosk | Registration submitted successfully | `{ runner: { name, className, startTime, ... } }` |
| `kiosk-reset` | Admin → Kiosk | Reset to idle (dialog closed, ESC, sticky clear) | — |
| `kiosk-ping` | Both directions | Heartbeat (every 5s during registration) | `{ from: "admin" \| "kiosk" }` |
| `readout-applied` | Admin → kiosk | After an online apply attempt; the kiosk refetches readout, runner and receipt | `{ cardNumber }` |
| `kiosk-print-receipt` | Kiosk → Admin | Kiosk needs receipt printed | `{ runnerId }` |

### 7c. Kiosk State Machine

```
                    card-reading
        idle ─────────────────────▶ reading
         ▲                             │
         │                        card-readout
    auto-reset                    (action determined)
    (15-20s)                           │
         │            ┌────────────────┼────────────────┐
         │            │                │                │
         │       action=readout   action=pre-start  action=register
         │            │                │                │
         │            ▼                ▼                ▼
         │      ┌──────────┐    ┌──────────┐    ┌─────────────────┐
         │      │ card-done│    │ card-done│    │ registration-   │
         │      │ (2s)     │    │ (2s)     │    │ waiting         │
         │      └────┬─────┘    └────┬─────┘    │ (live form      │
         │           │               │          │  preview)       │
         │           ▼               ▼          └────────┬────────┘
         │      ┌──────────┐    ┌──────────┐             │
         │      │ readout  │    │ pre-start│    registration-complete
         │      │ screen   │    │ screen   │             │
         │      └────┬─────┘    └────┬─────┘             ▼
         │           │               │          ┌─────────────────┐
         │           │               │          │ registration-   │
         └───────────┴───────────────┴──────────┤ complete (20s)  │
                                                └─────────────────┘
```

Registration goes directly to `registration-waiting` (no `card-done` transition), since the admin needs to fill the form.

### 7d. Kiosk Screens

**Idle** — Competition name, animated SI card slot, "Insert Card" prompt, live clock.

**Reading** — Animated spinner, "Do Not Remove Card" warning, card number display.

**Card Done** — Success checkmark animation, 2-second transition to result screen.

**Readout** — The main result display:
- Status badge (green OK, red MP, amber DNF)
- Runner name, club, class
- Running time (large)
- Position in class (rank/total)
- Controls matched vs. expected
- Missing controls list (if MP)
- On MP, one line "See the official at the readout desk" (`kiosk-see-official`) — another variant's run is accepted at the desk, never here (§4f)
- Class results table
- Auto-triggers receipt print

**Pre-Start** — For registered runners who haven't raced:
- Ready/Not Ready badge (based on clear+check validation)
- Course info and distance
- Start time with live countdown ("3 minutes 42 seconds to start")

**Registration Waiting** — While admin fills the form:
- Animated spinner
- Live preview of form data (name, club, class, payment)
- Swish QR code (if applicable)
- 15-second watchdog timer (resets on each `registration-state` message)

**Registration Complete** — After successful registration:
- Green checkmark
- Runner name, club, class
- Assigned start time
- Auto-resets to idle after 20 seconds

### 7e. Standalone Mode

The kiosk can operate independently with its own SI reader (no admin window needed). In standalone mode:

- Kiosk creates its own DeviceManager connection
- Card events are processed locally; with the server unreachable they are queued and drained by the kiosk itself (§2c-1, §2c-2)
- State transitions follow the same logic
- Registration dialog can still be opened (kiosk acts as both admin and display)

Configured via the settings gear icon: "Standalone mode" checkbox.

### 7f. Receipt Printing

The kiosk delegates printing to the admin window (which holds the WebUSB printer connection):

1. Kiosk readout screen detects finish → sends `kiosk-print-receipt` with `runnerId`
2. Admin's CompetitionShell receives message → fetches receipt data via `race.finishReceipt`
3. Admin prints via PrinterContext (WebUSB ESC/POS)

---

## 8. Registration Dialog

### 8a. Trigger

The dialog opens when DeviceManager determines `action = "register"` (no runner found for the scanned card). In sticky mode (kiosk workflow), it stays open between registrations and auto-fills from the next card scan.

### 8b. Pre-Fill Priority

Data sources are applied in strict priority order:

1. **DB runner** (`runner.findByCard`) — If a runner already exists with this CardNo, pre-fill from DB. This always wins.
2. **Eventor lookup** (`eventor.lookupByCardNo`) — If no DB match, check the Swedish Orienteering Federation's database by card number.
3. **Card owner data** (SI card memory) — Only if no DB match AND no Eventor match AND name is empty. Filtered through `isRealOwnerName()`.

```typescript
function isRealOwnerName(firstName?: string, lastName?: string): boolean {
  if (!firstName && !lastName) return false;
  if (firstName && /^\d+$/.test(firstName.trim())) return false;     // "8488001"
  if (lastName && /sportident/i.test(lastName)) return false;        // "SPORTident Sweden"
  return true;
}
```

This filters SPORTident factory defaults (card number as first name, "SPORTident Sweden" as last name) which appear on cards that were never personalized.

Non-name fields (birth year, sex, phone, club) are filled from owner data immediately since they don't conflict with DB lookups.

### 8c. Name Autocomplete

When typing ≥2 characters, the dialog searches two sources:

1. **Eventor club members** — Members of the selected club (if available)
2. **Global runner database** — All runners synced from Eventor

Results are deduplicated, limited to 12, and navigable with arrow keys.

### 8d. Submission

Creates the runner via `runner.create()` with all form fields. The dialog
sends no `courseId`: in a class on a forked course the server deals the
runner the least-populated variant (§5c), which the desk can change on
the Runners page. After success:

1. Sends `registration-complete` to kiosk
2. Prints registration receipt (if printer connected)
3. Invalidates caches (runner list, dashboard)
4. In sticky mode: clears form, waits 3 seconds, sends `kiosk-reset`

---

## 9. Data Flow: Complete Sequence Diagrams

### Registration (New Runner)

```
Runner inserts SI card
    │
    ▼
WebSerial reads card data
    │
    ▼
DeviceManager.addRecentCard()
    ├── isPunchDataFresh() → punchesFresh
    ├── storeReadout({ punchesFresh }) → backup to oxygen_card_readouts
    │                                    (oCard skipped: empty/stale card)
    ├── cardReadout.readout() → { found: false }
    ├── action = "register"
    └── BroadcastChannel → card-readout { action: "register" }
                                    │
    ┌───────────────────────────────┘
    │                               │
    ▼                               ▼
Admin: RegistrationDialog      Kiosk: registration-waiting
    │                               ▲
    ├── findByCard(cardNo) → null   │
    ├── eventor.lookupByCardNo()    │
    ├── ownerData pre-fill          │
    │                               │
    ├── registration-state ─────────┘  (every 2s)
    │
    ▼
Admin submits form
    ├── runner.create({ cardNo, name, classId, ... })
    │       └── Links existing oCard if found
    ├── registration-complete ──────▶ Kiosk: registration-complete
    └── Print registration receipt
```

### Readout (Existing Runner with Race Data)

```
Runner inserts SI card after racing
    │
    ▼
WebSerial reads card data
    │
    ▼
DeviceManager.addRecentCard()
    ├── isPunchDataFresh() → true
    ├── storeReadout({ punchesFresh: true })
    │       ├── Foreign control check → punchesRelevant: true
    │       ├── Backup to oxygen_card_readouts
    │       ├── oCard created/updated (all guards pass)
    │       │       ├── ReadId dedup check
    │       │       └── Runner linking (oRunner.Card = oCard.Id)
    │       └── return { cardId, punchesRelevant: true }
    │
    ├── cardReadout.readout()
    │       └── performReadout()
    │               ├── Load oCard punches (runner-linked)
    │               ├── Load free punches (oPunch / radio)
    │               ├── Merge + sort by time
    │               ├── matchPunchesToCourse()
    │               └── return { timing, controls, status }
    │
    ├── action = "readout" (punchesMatchCourse: true)
    ├── applyResult() → write Status/FinishTime/StartTime to oRunner
    └── BroadcastChannel → card-readout { action: "readout", status: "OK", ... }
                                    │
                                    ▼
                            Kiosk: card-done (2s) → readout screen
                                    │
                                    ├── Display result (OK/MP/DNF, time, position)
                                    └── kiosk-print-receipt → Admin prints finish receipt
```

### Pre-Start (Registered Runner, No Race Data)

```
Runner inserts SI card at start (card cleared or stale)
    │
    ▼
DeviceManager.addRecentCard()
    ├── isPunchDataFresh() → false (stale) or true (empty)
    ├── storeReadout() → oCard NOT written (guards fail)
    ├── cardReadout.readout() → { found: true, punchesMatchCourse: false }
    ├── action = "pre-start"
    └── BroadcastChannel → card-readout { action: "pre-start" }
                                    │
                                    ▼
                            Kiosk: card-done (2s) → pre-start screen
                                    │
                                    ├── Ready/Not Ready badge
                                    ├── Course info
                                    └── Start time countdown
```

---

## 10. MeOS Compatibility

### oCard Table

The `oCard` table is shared between Oxygen and MeOS. Both systems can read and write to it. Key compatibility points:

- **Punch string format**: Both use `"{type}-{seconds}.{tenths};"`. MeOS may add `@unit` and `#origin` suffixes (e.g., `41-36120.0@42#1;`). Oxygen's `parsePunches()` extracts and preserves `@unit` (timing station identifier for multi-unit time adjustment) and strips `#origin` (tamper-detection checksum, not needed for results). When encoding, `fmtPunch()` includes `@unit` when present.
- **ReadId**: Both compute the same hash for deduplication. Oxygen's `computeReadId()` matches MeOS's `SICard::calculateHash`.
- **Multiple oCard rows**: When both systems create oCards for the same CardNo, Oxygen prefers the runner-linked one. The runner FK (`oRunner.Card`) is the authoritative link.

### Time Format: ZeroTime-Relative Storage

All times in the database are stored as **ZeroTime-relative deciseconds**. ZeroTime is the competition's reference point (default: 324000 = 09:00:00), stored in `oEvent.ZeroTime`. This matches MeOS behavior exactly.

```
Absolute time → Stored (relative to ZeroTime 09:00:00)
10:00:00       → 36000 ds   (360000 - 324000)
10:02:00       → 37200 ds   (361200 - 324000)
08:50:00       → -6000 ds   (318000 - 324000)
```

**Conversion at the API boundary:**

- **DB writes**: `toRelative(absoluteDs, zeroTime) = absoluteDs - zeroTime`
- **DB reads**: `toAbsolute(relativeDs, zeroTime) = (relativeDs + zeroTime) % 864000`
- **API always speaks absolute times** — the web UI never sees relative values
- **Running time = finishTime - startTime** is the same in both frames (no conversion needed)

Sentinel value: `StartTime = 1` means "drawn with no specific time" (MeOS convention for interval=0 draws). It is preserved through the conversion layer and treated as "started" in dashboard/status logic.

**Files:**
- `packages/api/src/timeConvert.ts` — `toRelative()` and `toAbsolute()` helpers
- `packages/api/src/db.ts` — `getZeroTime(client)` — cached ZeroTime lookup (defaults to 324000)

### Counter Increments

Every write to `oRunner` or `oCard` must call `incrementCounter()` to update the `oCounter` table. This is how MeOS detects external changes and refreshes its view.

## 11. Readout-Station Backup Memory Recovery

Last-line-of-defence when Oxygen itself is broken (server bug, hardware died, etc.) and the offline-architecture relay isn't available either. Runners can still read out on a standalone SI readout station (BSM-family in M_READOUT mode) — the station's own beep confirms the readout was stored in its internal flash. Later, when Oxygen is back, the operator places the station on a USB coupler, dumps the flash through Oxygen, and replays each readout through the normal `storeReadout` pipeline.

**Operator flow:**

1. **Connect** the readout station to a laptop (direct USB, or via coupler for a standalone station). Open `/:nameId/controls` → "Read Controls" panel.
2. **Read backup**. The panel detects the station's operating mode from SYS_VAL `0x71`. If it's M_READOUT (`0x05`), the panel calls `parseReadoutBackupBuffer()` on the raw flash and ships the parsed records to `cardReadout.importReadoutBackups`.
3. **Status line** in the panel: *"Imported N of M cards (K duplicates) → review on Backup Punches"*. The duplicates count is silent dedup via the `(eventId, punchesHash)` unique constraint — re-importing the same flash is always safe.
4. **Review** on `/:nameId/backup-punches` → "Card readouts" tab. Each row shows: cardNo, cardType, runner (if registered), punch count, start/finish, match-status badge. Match-statuses are: `pushed` (already replayed), `pending` (ready to push), `no_runner` (cardNo not registered).
5. **Push** rows individually. Push calls `pushReadoutBackup` which reuses `storeReadoutImpl` — the same core that powers a live `storeReadout`. The runner gets the same card upsert, runner link, result computation (written with the guards of §3a-guard in the same transaction, `apply` in the response) and Google Sheets webhook as if the readout had just happened live. A held or protected row shows its `apply.outcome` and nothing is written for it. Idempotent: re-pushing the same row returns the existing `pushedReadoutId` without doing the work again.

**Storage shape:**

`card_readout_backups` is a staging table — not the same as the live `card_readouts`. Each row carries:

- `station_serial`, `slot_address` — where in flash the slot was found (debug)
- `card_no`, `card_type`, `punches`, `start_time`, `finish_time`, `check_time`, `clear_time`, `owner_data` — the parsed card readout, in the same shape `storeReadout` accepts
- `punches_hash` — `sha256(cardNo + sorted-by-time controlCode:time list)`, the dedup key
- `original_read_at` — populated from the 4-byte slot header if/when that decodes; currently NULL
- `imported_at`, `pushed_at`, `pushed_readout_id` — lifecycle markers
- `raw_bytes` — original slot bytes, kept by default for forensics

The `@@unique([eventId, punchesHash])` constraint means re-imports of the same flash or imports from multiple stations that happen to share a card-readout are deduped silently. Operators do not need to be careful about double-importing.

**Why a separate table** (vs reusing `card_readouts` with a flag): backup readouts have different lifecycle states (imported / reviewed / pushed) and bigger metadata (raw bytes, slot identity). Keeping them separate keeps the live readout path free of staging states. Cleanup is also a one-liner: `DELETE FROM card_readout_backups WHERE event_id = X`.

**Wire-format details** (slot byte layouts, marker bytes, slot sizes per card type, paging) are in [`docs/si-protocol/readout-backup-format.md`](../si-protocol/readout-backup-format.md), with the reference pcap + Config+ ground-truth file checked in alongside.

**Out of scope** (intentionally — these belong to a separate larger rewrite):
- Programming a station's operating-mode byte from Oxygen (writing `0x05` to SYS_VAL `0x71`). Operators continue to use Config+ to set a station as readout.
- Untangling `ControlStatus` (the enum currently conflates *course role* like `ok`/`bad`/`multiple` with *physical operating mode* like `start`/`finish`/`check`/`clear`). Readout mode isn't represented at all today; that's part of the bigger cleanup.

**Key files:**
- `packages/web/src/lib/si-protocol.ts` — `parseReadoutBackupBuffer()`, `isReadoutMode()`
- `packages/web/src/lib/webserial.ts` — `readBackupMemory()` (mode-aware)
- `packages/api/src/routers/cardReadout.ts` — `importReadoutBackups`, `listReadoutBackups`, `pushReadoutBackup`, plus the extracted `storeReadoutImpl` helper
- `packages/web/src/pages/ControlsPage.tsx` → `ReadoutPanel` — mode-aware import path
- `packages/web/src/pages/BackupPunchesPage.tsx` — "Card readouts" tab
